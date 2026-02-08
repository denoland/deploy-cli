import { createTrpcClient, getAuth } from "./auth.ts";
import type { GlobalContext } from "./main.ts";
import { error } from "./util.ts";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { fromFileUrl, join, resolve } from "@std/path";
import {
  applyEdits as applyJSONCEdits,
  modify as modifyJSONC,
  parse as parseJSONC,
} from "jsonc-parser";
import {
  resolve_config,
  resolve_config_with_deploy_config,
} from "./lib/rs_lib.js";
import { ValidationError } from "@cliffy/command";

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

    const orgs: Array<{
      name: string;
      slug: string;
      id: string;
      // deno-lint-ignore no-explicit-any
    }> = await (trpcClient.orgs as any).list.query();

    if (org !== undefined) {
      const fullOrg = orgs.find((fullOrg) => fullOrg.slug === org);
      if (!fullOrg) {
        error(context, `Organization '${org}' does not exist.`);
      }
    } else if (orgs.length === 1) {
      org = orgs[0].slug;
    } else {
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
      console.log(`Selected organization '${selectedOrg.value.name}'`);
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

    const apps: Array<{ name: string; slug: string }> =
      // deno-lint-ignore no-explicit-any
      await (trpcClient.apps as any).list.query({ org });
    const appStrings: PromptEntry<{ name: string; slug: string } | null>[] =
      apps.map((app) => ({ label: app.slug, value: app }));
    if (canCreate) {
      appStrings.unshift({ label: "Create a new application", value: null });
    }
    const selectedApp = promptSelect("Select an application:", appStrings, {
      clear: true,
    });
    if (!selectedApp) {
      console.error("No application was selected.");
      Deno.exit(1);
    }

    if (selectedApp.value === null) {
      // TODO: const createdOrgAndApp = await create(context, rootPath!, org);
      app = createdOrgAndApp.app;
      created = true;
    } else {
      app = selectedApp.value.slug;
      console.log(`Selected application '${selectedApp.value.slug}'`);
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
      const config = await readConfig(
        rootPath?.(...args) ?? Deno.cwd(),
        context.config,
      );
      const configContext: ConfigContext = {
        ...getAppFromConfig(config),
        configSaved: false,
        doNotCreate: false,
        save() {
          if (this.configSaved) {
            return Promise.resolve();
          }
          this.configSaved = true;

          if (this.doNotCreate && !config) {
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
  path: string;
  content: string;
}

async function readConfig(
  rootPath: string,
  maybeConfigPath: string | undefined,
): Promise<Config | null> {
  rootPath = resolve(rootPath);
  if (maybeConfigPath) {
    const content = await Deno.readTextFile(maybeConfigPath);
    return { path: maybeConfigPath, content };
  }

  // we prefer the configs with the deploy key. then we fallback to a general
  // config, so when we set the values, it uses existing config files instead
  // of trying to create a new one (which will still happen if no config file is found)

  const configUrl = resolve_config_with_deploy_config(rootPath);

  if (configUrl) {
    const path = fromFileUrl(configUrl);
    const content = await Deno.readTextFile(path);
    return { path, content };
  }

  const configUrlWithoutDeployConfig = resolve_config(rootPath);

  if (configUrlWithoutDeployConfig) {
    const path = fromFileUrl(configUrlWithoutDeployConfig);
    const content = await Deno.readTextFile(path);
    return { path, content };
  }

  return null;
}

function getAppFromConfig(
  configContent: Config | null,
): { org: undefined | string; app: undefined | string } {
  if (configContent) {
    const config = parseJSONC(configContent.content);
    if (
      typeof config === "object" && config !== null && "deploy" in config &&
      typeof config.deploy === "object" && config.deploy !== null &&
      !Array.isArray(config.deploy)
    ) {
      return {
        org: config.deploy.org,
        app: config.deploy.app,
      };
    }
  }

  return {
    org: undefined,
    app: undefined,
  };
}

async function writeConfig(
  configContent: Config | null,
  { org, app }: { org: undefined | string; app: undefined | string },
) {
  if (!org) {
    return;
  }

  const content = configContent?.content ?? "{}\n";

  const newConfig: Record<string, string> = { org };

  if (app) {
    newConfig.app = app;
  }

  const edits = modifyJSONC(content, ["deploy"], newConfig, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  });
  const out = applyJSONCEdits(content, edits);
  await Deno.writeTextFile(
    configContent?.path ?? join(Deno.cwd(), "deno.jsonc"),
    out,
  );

  if (!configContent) {
    console.log(
      `Created configuration file at '${join(Deno.cwd(), "deno.jsonc")}'`,
    );
  }
}
