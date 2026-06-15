import { createTrpcClient, getAuth } from "./auth.ts";
import type { GlobalContext } from "./main.ts";
import { error, requireInteractive } from "./util.ts";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { fromFileUrl, join, resolve } from "@std/path";
import { parse as parseJSONC } from "@david/jsonc-morph";
import { resolve_config } from "./lib/rs_lib.js";
import { ValidationError } from "@cliffy/command";
import { createFlow } from "./deploy/create/flow.ts";
import { createApp } from "./deploy/create/mod.ts";

export async function getOrg(
  context: GlobalContext,
  config: ConfigMetadataContext,
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
      console.log(`Selected organization '${selectedOrg.value.name}'`);
    }
  }

  config.org = org;

  return org;
}

export async function getApp(
  context: GlobalContext,
  config: ConfigMetadataContext,
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
  config: ConfigMetadataContext,
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
      // The "create a new application" entry is only offered when canCreate is
      // true, and that overload requires a files-bearing ConfigContext, so the
      // subsequent publish() inside createApp() always has source files.
      await createApp(
        context,
        config as ConfigContext,
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
      console.log(`Selected application '${selectedApp.value.slug}'`);
    }
  }

  config.app = app;

  return {
    app,
    created,
  };
}

/**
 * Config-derived state shared by every command: the resolved `deploy.org` /
 * `deploy.app` plus helpers to persist them back to `deno.json(c)`. This carries
 * NO source-file list, so commands that only need metadata (sandbox, logs, env,
 * database, apps, orgs, deployments, whoami, ...) never trigger a downward
 * filesystem walk.
 */
export interface ConfigMetadataContext {
  org: undefined | string;
  app: undefined | string;
  configSaved: boolean;
  doNotCreate: boolean;
  save(): Promise<void>;
  noSave(): void;
  noCreate(): void;
}

/**
 * Metadata plus the collected local source files for publish/diffsync. Only
 * local deploy/create flows use this; it is produced exclusively by
 * {@link sourceActionHandler}.
 */
export interface ConfigContext extends ConfigMetadataContext {
  files: string[];
}

interface CommandActionThis {
  getLiteralArgs(): string[];
}

/**
 * Wrap a command action that only needs deploy-config metadata (org/app). The
 * config file is discovered via an upward lookup; source files are NOT
 * collected. This is the default for management and sandbox commands.
 */
export function actionHandler<
  O extends GlobalContext,
  A extends unknown[] = unknown[],
>(
  cb: (
    this: CommandActionThis,
    configContext: ConfigMetadataContext,
    options: O,
    ...args: A
  ) => void | Promise<void>,
  rootPath?: (...args: A) => string | undefined,
): (options: O, ...args: A) => Promise<void> {
  return async function (this: CommandActionThis, context: O, ...args: A) {
    try {
      const metadata = await readDeployConfigMetadata(
        rootPath?.(...args) ?? Deno.cwd(),
        context.config,
        context.debug,
      );
      const configContext = createConfigContext(metadata);

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
      error(context, errorMessage(e));
    }
  };
}

/**
 * Wrap a command action that needs the local source files for publish/diffsync
 * (local `deno deploy` and `deno deploy create`). This performs the downward
 * source-file collection that {@link actionHandler} deliberately skips.
 */
export function sourceActionHandler<
  O extends GlobalContext,
  A extends unknown[] = unknown[],
>(
  cb: (
    this: CommandActionThis,
    configContext: ConfigContext,
    options: O,
    ...args: A
  ) => void | Promise<void>,
  rootPath?: (...args: A) => string | undefined,
): (options: O, ...args: A) => Promise<void> {
  return async function (this: CommandActionThis, context: O, ...args: A) {
    try {
      const source = await collectDeploySourceFiles(
        rootPath?.(...args) ?? Deno.cwd(),
        context.config,
        context.ignore ?? [],
        context.allowNodeModules ?? false,
        context.debug,
      );
      const configContext: ConfigContext = {
        ...createConfigContext(source),
        files: source.files,
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
      error(context, errorMessage(e));
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface ConfigFile {
  path: string;
  content: string;
}

interface ResolvedConfig {
  config?: ConfigFile;
  files: string[];
}

/**
 * Deploy-config metadata: the resolved config file (if any) plus the
 * `deploy.org` / `deploy.app` values read from it. Contains no source files.
 */
export interface DeployConfigMetadata {
  config?: ConfigFile;
  org?: string;
  app?: string;
}

/**
 * The local source files to publish, plus the deploy-config metadata they were
 * resolved alongside.
 */
export interface DeploySourceFiles extends DeployConfigMetadata {
  files: string[];
}

/**
 * Read deploy-config metadata (`deploy.org` / `deploy.app`) without collecting
 * any source files. Safe to call from any directory, including `/`.
 */
export async function readDeployConfigMetadata(
  rootPath: string,
  maybeConfigPath: string | undefined,
  debug: boolean,
): Promise<DeployConfigMetadata> {
  const resolved = await resolveConfig(
    rootPath,
    maybeConfigPath,
    [],
    false,
    false,
    debug,
  );
  return { config: resolved.config, ...parseDeployOrgApp(resolved) };
}

/**
 * Collect the local source files for publish/diffsync, applying
 * `deploy.include` / `deploy.exclude`, explicit ignore paths, and the
 * `node_modules` default. Also returns the deploy-config metadata.
 */
export async function collectDeploySourceFiles(
  rootPath: string,
  maybeConfigPath: string | undefined,
  ignorePaths: string[],
  allowNodeModules: boolean,
  debug: boolean,
): Promise<DeploySourceFiles> {
  const resolved = await resolveConfig(
    rootPath,
    maybeConfigPath,
    ignorePaths,
    allowNodeModules,
    true,
    debug,
  );
  return {
    config: resolved.config,
    files: resolved.files,
    ...parseDeployOrgApp(resolved),
  };
}

async function resolveConfig(
  rootPath: string,
  maybeConfigPath: string | undefined,
  ignorePaths: string[],
  allowNodeModules: boolean,
  collectFiles: boolean,
  debug: boolean,
): Promise<ResolvedConfig> {
  const config = resolve_config(
    resolve(maybeConfigPath || rootPath),
    ignorePaths,
    allowNodeModules,
    collectFiles,
    debug,
  );

  if (config.path) {
    const path = fromFileUrl(config.path);
    const content = await Deno.readTextFile(path);
    return { config: { path, content }, files: config.files };
  }

  return { files: config.files };
}

function parseDeployOrgApp(
  resolved: ResolvedConfig,
): { org: undefined | string; app: undefined | string } {
  if (resolved.config) {
    const config = parseJSONC(resolved.config.content);
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

function createConfigContext(
  metadata: DeployConfigMetadata,
): ConfigMetadataContext {
  return {
    org: metadata.org,
    app: metadata.app,
    configSaved: false,
    doNotCreate: false,
    save() {
      if (this.configSaved) {
        return Promise.resolve();
      }
      this.configSaved = true;

      if (this.doNotCreate && !metadata) {
        return Promise.resolve();
      }

      return writeConfig(metadata, {
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
}

async function writeConfig(
  configContent: { config?: ConfigFile },
  { org, app }: { org: undefined | string; app: undefined | string },
) {
  if (!org) {
    return;
  }

  const content = configContent.config?.content ?? "{}\n";

  const newConfig: Record<string, string> = { org };

  if (app) {
    newConfig.app = app;
  }

  const config = parseJSONC(content);
  const deployObj = config.asObjectOrForce().getIfObjectOrForce("deploy");
  deployObj.replaceWith(newConfig);
  deployObj.ensureMultiline();

  await Deno.writeTextFile(
    configContent.config?.path ?? join(Deno.cwd(), "deno.jsonc"),
    config.toString() + "\n",
  );

  if (!configContent.config) {
    console.log(
      `Created configuration file at '${join(Deno.cwd(), "deno.jsonc")}'`,
    );
  }
}
