import { createTrpcClient, getAuth } from "./auth.ts";
import type { GlobalContext } from "./main.ts";
import { error, requireInteractive } from "./util.ts";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { dirname, join, resolve } from "@std/path";
import { parse as parseJSONC } from "@david/jsonc-morph";
import { resolve_config } from "./lib/rs_lib.js";
import { ValidationError } from "@cliffy/command";
import { createFlow } from "./deploy/create/flow.ts";
import { createApp } from "./deploy/create/mod.ts";

export async function getOrg(
  context: GlobalContext,
  config: ConfigContext,
  org: string | undefined,
): Promise<string> {
  await getAuth(context, false);

  org ??= config.org;

  if (!org) {
    org = Deno.env.get("DENO_DEPLOY_ORG");
  }

  if (!org) {
    const trpcClient = createTrpcClient(context);

    const orgs = await trpcClient.query("orgs.list") as Array<{
      name: string;
      slug: string;
      id: string;
    }>;

    if (org !== undefined) {
      const fullOrg = orgs.find((fullOrg) => fullOrg.slug === org);
      if (!fullOrg) {
        error(context, `Organization '${org}' does not exist.`);
      }
    } else if (orgs.length === 1) {
      org = orgs[0].slug;
    } else {
      requireInteractive(
        context,
        "Use --org to specify the organization.",
      );
      const selectedOrg = promptSelect(
        "Select an organization:",
        orgs.map((org) => ({ label: `${org.name} (${org.slug})`, value: org })),
        {
          clear: true,
        },
      );
      if (!selectedOrg) {
        error(context, "No organization was selected.");
      }

      org = selectedOrg.value.slug;
      console.error(`Selected organization '${selectedOrg.value.name}'`);
    }
  }

  config.org = org;

  return org;
}

export async function getApp(
  context: GlobalContext,
  config: ConfigContext,
  canCreate: false,
  org: string,
  app: string | undefined | null,
): Promise<{ app: string; created: false }>;
export async function getApp(
  context: GlobalContext,
  config: ConfigContext,
  canCreate: true,
  org: string,
  app: string | undefined | null,
  rootPath: string,
): Promise<{ app: string; created: boolean }>;
export async function getApp(
  context: GlobalContext,
  config: ConfigContext,
  canCreate: boolean,
  org: string,
  app: string | undefined | null,
  rootPath?: string,
): Promise<{ app: string | null; created: boolean }> {
  await getAuth(context, false);

  app ??= config.app;

  if (app === undefined) {
    app = Deno.env.get("DENO_DEPLOY_APP");
  }

  if (app === null) {
    return {
      app: null,
      created: false,
    };
  }

  let created = false;
  if (app === undefined) {
    const trpcClient = createTrpcClient(context);

    const apps = await trpcClient.query("apps.list", { org }) as Array<{
      name: string;
      slug: string;
    }>;
    requireInteractive(
      context,
      "Use --app to specify the application.",
    );
    const appStrings: PromptEntry<{ name: string; slug: string } | null>[] =
      apps.map((app) => ({ label: app.slug, value: app }));
    if (canCreate) {
      appStrings.unshift({ label: "Create a new application", value: null });
    }
    const selectedApp = promptSelect("Select an application:", appStrings, {
      clear: true,
    });
    if (!selectedApp) {
      error(context, "No application was selected.");
    }

    if (selectedApp.value === null) {
      const data = await createFlow(context, rootPath!, org);
      await createApp(
        context,
        config,
        data,
        rootPath!,
        true,
      );
      config.org = data.org;
      config.app = data.app;
      app = data.app;
      created = true;
    } else {
      app = selectedApp.value.slug;
      console.error(`Selected application '${selectedApp.value.slug}'`);
    }
  }

  config.app = app;

  return {
    app,
    created,
  };
}

export interface ConfigContext {
  org: undefined | string;
  app: undefined | string;
  files: string[];
  configSaved: boolean;
  doNotCreate: boolean;
  save(): Promise<void>;
  noSave(): void;
  noCreate(): void;
}

export function actionHandler<
  O extends GlobalContext,
  A extends unknown[] = unknown[],
>(
  cb: (
    // deno-lint-ignore no-explicit-any
    this: any,
    configContext: ConfigContext,
    options: O,
    ...args: A
  ) => void | Promise<void>,
  rootPath?: (...args: A) => string | undefined,
): (options: O, ...args: A) => Promise<void> {
  return async function (this: unknown, context: O, ...args: A) {
    try {
      const root = rootPath?.(...args) ?? Deno.cwd();
      // Discover the config file only (cheap). The deploy file manifest is a
      // full recursive walk of `root` that can be huge/slow, so it is collected
      // lazily via `configContext.files` and paid for only by the upload path
      // (see `readDeployFiles`). Read-only commands (whoami, orgs/apps/env list,
      // logs, ...) never touch `.files`, so they never trigger the walk — which
      // previously hung them when invoked from a large working directory.
      const config = await discoverConfig(
        root,
        context.config,
      );
      let collectedFiles: string[] | undefined;
      const configContext: ConfigContext = {
        ...getAppFromConfig(config),
        get files(): string[] {
          if (collectedFiles === undefined) {
            collectedFiles = readDeployFiles(
              root,
              context.config,
              context.ignore ?? [],
              context.allowNodeModules ?? false,
              context.debug,
            );
          }
          return collectedFiles;
        },
        configSaved: false,
        doNotCreate: false,
        save() {
          if (this.configSaved) {
            return Promise.resolve();
          }
          this.configSaved = true;

          // Skip writing only with no existing file to update (`config` is the
          // always-truthy wrapper; `config.config` is the file, if any).
          if (this.doNotCreate && !config.config) {
            return Promise.resolve();
          }

          return writeConfig(config, {
            org: this.org,
            app: this.app,
          });
        },
        noSave() {
          this.configSaved = true;
        },
        noCreate() {
          this.doNotCreate = true;
        },
      };

      await cb.call(
        this,
        configContext,
        context,
        ...args,
      );

      await configContext.save();
    } catch (e) {
      if (e instanceof ValidationError) {
        throw e;
      }
      error(context, (e as Error).message);
    }
  };
}

interface Config {
  config?: {
    path: string;
    content: string;
  };
}

const CONFIG_FILE_NAMES = ["deno.json", "deno.jsonc"] as const;

/**
 * Locate the deploy config file (for `org`/`app`) WITHOUT collecting the deploy
 * file manifest. This is intentionally cheap: an explicit `--config` is used
 * as-is, otherwise we walk UP from the root looking for a `deno.json[c]`. It
 * deliberately avoids `resolve_config`, whose recursive DOWNward file walk to
 * build the upload manifest can be enormous — and is only needed by the upload
 * path (`configContext.files` -> `readDeployFiles`), not by read-only commands.
 */
async function discoverConfig(
  rootPath: string,
  maybeConfigPath: string | undefined,
): Promise<Config> {
  if (maybeConfigPath) {
    const path = resolve(maybeConfigPath);
    const content = await Deno.readTextFile(path);
    return { config: { path, content } };
  }

  let dir = resolve(rootPath);
  try {
    if ((await Deno.stat(dir)).isFile) {
      dir = dirname(dir);
    }
  } catch {
    // Non-existent root: nothing to discover.
  }

  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const path = join(dir, name);
      try {
        const content = await Deno.readTextFile(path);
        return { config: { path, content } };
      } catch {
        // Not here; keep looking upward.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return {};
    }
    dir = parent;
  }
}

/**
 * Collect the recursive deploy file manifest for the upload. This is the
 * expensive full-directory walk (via the wasm `resolve_config`); call it only
 * when the files are actually needed (i.e. from the upload path).
 */
function readDeployFiles(
  rootPath: string,
  maybeConfigPath: string | undefined,
  ignorePaths: string[],
  allowNodeModules: boolean,
  debug: boolean,
): string[] {
  // Only `--config <file>` is parsed as a config file; a positional root is not.
  const fromConfig = Boolean(maybeConfigPath);
  const config = resolve_config(
    resolve(maybeConfigPath || rootPath),
    fromConfig,
    ignorePaths,
    allowNodeModules,
    debug,
  );
  return config.files;
}

function getAppFromConfig(
  configContent: Config,
): { org: undefined | string; app: undefined | string } {
  if (configContent.config) {
    const config = parseJSONC(configContent.config.content);
    const deployObj = config.asObject()?.getIfObject("deploy");

    if (deployObj) {
      return {
        org: deployObj.get("org")?.value()?.asString(),
        app: deployObj.get("app")?.value()?.asString(),
      };
    }
  }

  return {
    org: undefined,
    app: undefined,
  };
}

async function writeConfig(
  configContent: Config,
  { org, app }: { org: undefined | string; app: undefined | string },
) {
  if (!org) {
    return;
  }

  const content = configContent.config?.content ?? "{}\n";

  const config = parseJSONC(content);
  const deployObj = config.asObjectOrForce().getIfObjectOrForce("deploy");

  const upsertKey = (key: string, value: string) => {
    const prop = deployObj.get(key);
    if (prop) {
      prop.setValue(value);
    } else {
      deployObj.append(key, value);
    }
  };

  upsertKey("org", org);
  if (app) {
    upsertKey("app", app);
  } else {
    deployObj.get("app")?.remove();
  }

  deployObj.ensureMultiline();

  await Deno.writeTextFile(
    configContent.config?.path ?? join(Deno.cwd(), "deno.jsonc"),
    config.toString() + "\n",
  );

  if (!configContent.config) {
    console.error(
      `Created configuration file at '${join(Deno.cwd(), "deno.jsonc")}'`,
    );
  }
}
