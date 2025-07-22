import { Command } from "@cliffy/command";
import { getAppFromConfig, readConfig } from "./config.ts";
import { withApp } from "./util.ts";
import { createTrpcClient } from "./auth.ts";

interface EnvVar {
  id: string;
  key: string;
  value: string;
  context_ids: string[];
}

interface Context {
  id: string;
  name: string;
}

type EnvCommandContext = {
  endpoint: string;
  org?: string;
  app?: string;
};

export const envListCommand = new Command<EnvCommandContext>()
  .description("List all environmental variables in an application")
  .action(async (options) => {
    const configContent = await readConfig(Deno.cwd());
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(options.endpoint, false, org, app);
    const trpcClient = createTrpcClient(options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    // deno-lint-ignore no-explicit-any
    const contexts: Context[] = await (trpcClient.envVarsContexts as any)
      .listContexts
      .query({
        org: orgAndApp.org,
      });

    const processed = envVars.map((envVar) => {
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

      return {
        key: envVar.key,
        value: envVar.value ?? "***",
        contexts: contextNames.join(", "),
      };
    });

    const contextTitle = `Contexts (${
      contexts.map((context) => context.name).join(", ")
    })`;

    let keyLength = 3;
    let valueLength = 5;

    for (const processedElement of processed) {
      keyLength = Math.max(keyLength, processedElement.key.length);
      valueLength = Math.max(valueLength, processedElement.value.length);
    }

    console.log(
      `${"Key".padEnd(keyLength)}   ${
        "Value".padEnd(valueLength)
      }   ${contextTitle}`,
    );

    for (const env of processed) {
      console.log(
        `${env.key.padEnd(keyLength)}   ${
          env.value.padEnd(valueLength)
        }   ${env.contexts}`,
      );
    }
  });

export const envAddCommand = new Command<EnvCommandContext>()
  .description("Add an environmental variable to the application")
  .option("--secret", "If the value should be secret", { default: false })
  .arguments("variable:string value:string")
  .action(async (options, variable, value) => {
    const configContent = await readConfig(Deno.cwd());
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(options.endpoint, false, org, app);
    const trpcClient = createTrpcClient(options.endpoint);

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
  });

export const envUpdateValueCommand = new Command<EnvCommandContext>()
  .description(
    "Update the value of an environmental variable in the application",
  )
  .arguments("variable:string value:string")
  .action(async (options, variable, value) => {
    const configContent = await readConfig(Deno.cwd());
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(options.endpoint, false, org, app);
    const trpcClient = createTrpcClient(options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      throw new Error(`Environment variable "${variable}" not found`);
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
  });

export const envUpdateContextsCommand = new Command<EnvCommandContext>()
  .description(
    `Update the contexts of an environmental variable in the application
You can define no contexts and it will set the value to "All"`,
  )
  .arguments("variable:string [new-contexts...:string]")
  .action(async (options, variable, ...newContexts) => {
    const configContent = await readConfig(Deno.cwd());
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(options.endpoint, false, org, app);
    const trpcClient = createTrpcClient(options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      throw new Error(`Environment variable "${variable}" not found`);
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
        throw new Error(`Context "${newContext}" not found`);
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
  });

export const envDeleteCommand = new Command<EnvCommandContext>()
  .description("Delete an environmental variable in the application")
  .arguments("variable:string")
  .action(async (options, variable) => {
    const configContent = await readConfig(Deno.cwd());
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;

    const orgAndApp = await withApp(options.endpoint, false, org, app);
    const trpcClient = createTrpcClient(options.endpoint);

    // deno-lint-ignore no-explicit-any
    const envVars: EnvVar[] = await (trpcClient.envVarsContexts as any).list
      .query({
        org: orgAndApp.org,
        app: orgAndApp.app,
      });

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      throw new Error(`Environment variable "${variable}" not found`);
    }

    // deno-lint-ignore no-explicit-any
    await (trpcClient.envVarsContexts as any).updateEnvVars.mutate({
      org: orgAndApp.org,
      add: [],
      update: [],
      remove: [envVar.id],
    });
  });
