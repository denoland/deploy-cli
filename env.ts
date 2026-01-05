import { Command } from "@cliffy/command";
import { parse as dotEnvParse } from "@std/dotenv";
import { getAppFromConfig, readConfig } from "./config.ts";
import { error, tablePrinter, withApp } from "./util.ts";
import { createTrpcClient } from "./auth.ts";
import type { GlobalOptions } from "./main.ts";

interface EnvVar {
  id: string;
  key: string;
  value: string;
  is_secret: boolean;
  context_ids: string[];
}

interface Context {
  id: string;
  name: string;
}

type EnvCommandContext = GlobalOptions & {
  org?: string;
  app?: string;
};

export const envListCommand = new Command<EnvCommandContext>()
  .description("List all environmental variables in an application")
  .action(async (options) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      app,
    );
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    if (envVars.length === 0) {
      console.log(
        "There are no environmental variables set on this application.",
      );
      return;
    }

    // deno-lint-ignore no-explicit-any
    const contexts: Context[] = await (trpcClient.envVarsContexts as any)
      .listContexts
      .query({
        org: orgAndApp.org,
      });

    const contextTitle = `CONTEXTS (${
      contexts.map((context) => context.name).join(", ")
    })`;

    tablePrinter(
      ["KEY", "VALUE", contextTitle],
      envVars,
      (envVar) => {
        const contextNames = [];

        if (envVar.context_ids) {
          for (const contextId of envVar.context_ids) {
            contextNames.push(
              contexts.find((context) => context.id === contextId)!.name,
            );
          }
        } else {
          contextNames.push("All");
        }

        return [
          envVar.key,
          envVar.value ?? "***",
          contextNames.join(", "),
        ];
      },
    );
  });

export const envAddCommand = new Command<EnvCommandContext>()
  .description("Add an environmental variable to the application")
  .option("--secret", "If the value should be secret", { default: false })
  .arguments("<variable:string> <value:string>")
  .action(async (options, variable, value) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      app,
    );
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    const fullApp = await (trpcClient.apps as any).get.query({
      org: orgAndApp.org,
      app: orgAndApp.app,
    });

    // deno-lint-ignore no-explicit-any
    await (trpcClient.envVarsContexts as any).updateEnvVars.mutate({
      org: orgAndApp.org,
      add: [
        {
          app_id: fullApp.id,
          key: variable,
          value,
          is_secret: options.secret,
          context_ids: null,
        },
      ],
      update: [],
      remove: [],
    });

    console.log(
      `Environmental variable '${variable}' has been successfully set.`,
    );
  });

export const envUpdateValueCommand = new Command<EnvCommandContext>()
  .description(
    "Update the value of an environmental variable in the application",
  )
  .arguments("<variable:string> <value:string>")
  .action(async (options, variable, value) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      app,
    );
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      error(options.debug, `Environment variable '${variable}' not found`);
    }

    // deno-lint-ignore no-explicit-any
    await (trpcClient.envVarsContexts as any).updateEnvVars.mutate({
      org: orgAndApp.org,
      add: [],
      update: [{
        id: envVar.id,
        value: value,
      }],
      remove: [],
    });

    console.log(
      `The value of the environmental variable '${variable}' has been successfully updated.`,
    );
  });

export const envUpdateContextsCommand = new Command<EnvCommandContext>()
  .description(
    `Update the contexts of an environmental variable in the application
You can define no contexts, which is the equivalent to "All"`,
  )
  .arguments("<variable:string> [new-contexts...:string]")
  .action(async (options, variable, ...newContexts) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      app,
    );
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      error(options.debug, `Environment variable '${variable}' not found`);
    }

    // deno-lint-ignore no-explicit-any
    const contexts: Context[] = await (trpcClient.envVarsContexts as any)
      .listContexts
      .query({
        org: orgAndApp.org,
      });

    const contextIds = [];

    for (const newContext of newContexts) {
      const context = contexts.find((context) => context.name === newContext);
      if (!context) {
        error(options.debug, `Context "${newContext}" not found`);
      }

      contextIds.push(context.id);
    }

    // deno-lint-ignore no-explicit-any
    await (trpcClient.envVarsContexts as any).updateEnvVars.mutate({
      org: orgAndApp.org,
      add: [],
      update: [{
        id: envVar.id,
        context_ids: newContexts.length === 0 ? null : contextIds,
      }],
      remove: [],
    });

    console.log(
      `The contexts of the environmental variable '${variable}' have been successfully updated`,
    );
  });

export const envDeleteCommand = new Command<EnvCommandContext>()
  .description("Delete an environmental variable in the application")
  .arguments("variable:string")
  .action(async (options, variable) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      app,
    );
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      error(options.debug, `Environment variable '${variable}' not found`);
    }

    // deno-lint-ignore no-explicit-any
    await (trpcClient.envVarsContexts as any).updateEnvVars.mutate({
      org: orgAndApp.org,
      add: [],
      update: [],
      remove: [envVar.id],
    });

    console.log(
      `Environmental variable '${variable}' has been successfully deleted`,
    );
  });

const PUBLIC_REGEX = /^PUBLIC_|^NEXT_PUBLIC_/;

const COMMON_SECRET_PATTERN =
  /^(?!.*(?:^|_)(PUBLIC|NEXT_PUBLIC|EXPOSED)(?:_|$)).*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIALS|AUTH)(?![A-Za-z])/i;

function isSecretKey(key: string): boolean {
  return COMMON_SECRET_PATTERN.test(key);
}

export const envLoadCommand = new Command<EnvCommandContext>()
  .description(
    "Load environmental variables from a .env file into the application",
  )
  .option(
    "--non-secrets <keys...:string>",
    "Which keys in the .env file to treat as non-secrets",
  )
  .arguments("<file:string>")
  .action(async (options, file) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      app,
    );
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    const fullApp = await (trpcClient.apps as any).get.query({
      org: orgAndApp.org,
      app: orgAndApp.app,
    });

    const variables = dotEnvParse(await Deno.readTextFile(file));

    // deno-lint-ignore no-explicit-any
    const existingEnvVars: EnvVar[] = await (trpcClient.envVarsContexts as any)
      .list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const addEnvVars = [];
    let updateEnvVars = [];

    const hasPublicPrefix = Object.keys(variables).some((key) =>
      PUBLIC_REGEX.test(key)
    );

    for (const [key, value] of Object.entries(variables)) {
      const existing = existingEnvVars.find((envVar) => envVar.key === key);
      let is_secret = existing?.is_secret || false;

      if (!options.nonSecrets?.includes(key)) {
        if (hasPublicPrefix) {
          is_secret = !PUBLIC_REGEX.test(key);
        } else {
          is_secret = isSecretKey(key);
        }
      } else {
        is_secret = false;
      }

      if (existing) {
        updateEnvVars.push({
          id: existing.id,
          key,
          value,
          is_secret,
          context_ids: existing.context_ids,
        });
      } else {
        addEnvVars.push({
          app_id: fullApp.id,
          key,
          value,
          is_secret,
          context_ids: null,
        });
      }
    }

    if (updateEnvVars.length > 0) {
      console.log("The following env vars are already defined:");
      for (const updateEnvVar of updateEnvVars) {
        console.log(` - ${updateEnvVar.key}`);
      }
      console.log();
      outer: while (true) {
        const res = prompt(
          "Would you like to replace these with your .env file? [y = Yes, n = No, s = Ignore/Skip]",
        );
        if (res) {
          switch (res.toLowerCase()) {
            case "y": {
              break outer;
            }

            // deno-lint-ignore no-fallthrough
            case "n": {
              error(options.debug, "Env vars are already defined, exiting");
            }
            case "s": {
              updateEnvVars = [];
              break outer;
            }
          }
        }
      }
      console.log();
    }

    // deno-lint-ignore no-explicit-any
    await (trpcClient.envVarsContexts as any).updateEnvVars.mutate({
      org: orgAndApp.org,
      add: addEnvVars,
      update: updateEnvVars,
      remove: [],
    });

    console.log(`.env file '${file}' has been successfully loaded.`);
  });
