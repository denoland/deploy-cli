import { Command } from "@cliffy/command";
import { parse as dotEnvParse } from "@std/dotenv";
import {
  error,
  ExitCode,
  isNonInteractive,
  tablePrinter,
  writeJsonResult,
} from "../util.ts";
import { green } from "@std/fmt/colors";
import { createTrpcClient } from "../auth.ts";
import type { GlobalContext } from "../main.ts";
import { actionHandler, getApp, getOrg } from "../config.ts";

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

type EnvCommandContext = GlobalContext & {
  org?: string;
  app?: string;
};

/**
 * Shape a backend env var into the public `--json` representation, masking the
 * value of secrets and resolving context ids to their human names. Shared by
 * `list` and the mutating commands so their JSON output stays identical.
 */
function shapeEnvVar(envVar: EnvVar, contexts: Context[]) {
  return {
    id: envVar.id,
    key: envVar.key,
    value: envVar.is_secret ? null : envVar.value,
    isSecret: envVar.is_secret,
    contexts: envVar.context_ids
      ? envVar.context_ids.map((id) =>
        contexts.find((c) => c.id === id)?.name ?? id
      )
      : null,
  };
}

/**
 * Re-read a single env var (and the org contexts) from the backend and shape it
 * for `--json` output. Used by the mutating commands to report the persisted
 * state of the variable they just changed. If the variable can't be read back
 * (read-after-write miss, key-normalization difference), this exits via
 * {@link error} with a structured `NOT_FOUND` envelope rather than returning a
 * value — so callers always emit the var object, never a bare `null`.
 */
async function fetchShapedEnvVar(
  context: GlobalContext,
  trpcClient: ReturnType<typeof createTrpcClient>,
  org: string,
  app: string,
  key: string,
) {
  const envVars = await trpcClient.query("envVarsContexts.list", {
    org,
    app,
  }) as EnvVar[];
  const contexts = await trpcClient.query(
    "envVarsContexts.listContexts",
    { org },
  ) as Context[];
  const envVar = envVars.find((envVar) => envVar.key === key);
  if (!envVar) {
    error(
      context,
      `Environment variable '${key}' could not be read back from the backend after the operation.`,
      {
        code: ExitCode.NOT_FOUND,
        errorCode: "ENV_VAR_NOT_FOUND",
      },
    );
  }
  return shapeEnvVar(envVar, contexts);
}

const envListCommand = new Command<EnvCommandContext>()
  .description("List all environment variables in an application")
  .action(actionHandler(async (config, options) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const trpcClient = createTrpcClient(options);

    const envVars = await trpcClient.query("envVarsContexts.list", {
      org,
      app,
    }) as EnvVar[];

    const contexts = await trpcClient.query(
      "envVarsContexts.listContexts",
      { org },
    ) as Context[];

    if (options.json) {
      writeJsonResult(envVars.map((envVar) => shapeEnvVar(envVar, contexts)));
      return;
    }

    if (envVars.length === 0) {
      console.log(
        "There are no environment variables set on this application.",
      );
      return;
    }

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
  }));

const envAddCommand = new Command<EnvCommandContext>()
  .description("Add an environment variable to the application")
  .option("--secret", "If the value should be secret", { default: false })
  .arguments("<variable:string> <value:string>")
  .example("Add a variable", "add DATABASE_URL postgres://localhost/mydb")
  .example("Add a secret", "add --secret API_KEY sk-1234")
  .action(actionHandler(async (config, options, variable, value) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const trpcClient = createTrpcClient(options);

    const fullApp = await trpcClient.query("apps.get", {
      org,
      app,
    }) as { id: string };

    await trpcClient.mutation("envVarsContexts.updateEnvVars", {
      org,
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

    if (options.json) {
      writeJsonResult(
        await fetchShapedEnvVar(options, trpcClient, org, app, variable),
      );
      return;
    }

    console.error(
      `${
        green("✔")
      } Environment variable '${variable}' has been successfully set.`,
    );
  }));

const envUpdateValueCommand = new Command<EnvCommandContext>()
  .description(
    "Update the value of an environment variable in the application",
  )
  .arguments("<variable:string> <value:string>")
  .action(actionHandler(async (config, options, variable, value) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const trpcClient = createTrpcClient(options);

    const envVars = await trpcClient.query("envVarsContexts.list", {
      org,
      app,
    }) as EnvVar[];

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      error(
        options,
        `Environment variable '${variable}' not found.\nUse 'env list' to see available variables.`,
      );
    }

    await trpcClient.mutation("envVarsContexts.updateEnvVars", {
      org,
      add: [],
      update: [{
        id: envVar.id,
        value: value,
      }],
      remove: [],
    });

    if (options.json) {
      writeJsonResult(
        await fetchShapedEnvVar(options, trpcClient, org, app, variable),
      );
      return;
    }

    console.error(
      `${
        green("✔")
      } The value of environment variable '${variable}' has been successfully updated.`,
    );
  }));

const envUpdateContextsCommand = new Command<EnvCommandContext>()
  .description(
    `Update the contexts of an environment variable in the application
You can define no contexts, which is the equivalent to "All"`,
  )
  .arguments("<variable:string> [new-contexts...:string]")
  .action(actionHandler(async (config, options, variable, ...newContexts) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    const envVars = await trpcClient.query("envVarsContexts.list", {
      org,
      app,
    }) as EnvVar[];

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      error(
        options,
        `Environment variable '${variable}' not found.\nUse 'env list' to see available variables.`,
      );
    }

    const contexts = await trpcClient.query(
      "envVarsContexts.listContexts",
      { org },
    ) as Context[];

    const contextIds = [];

    for (const newContext of newContexts) {
      const context = contexts.find((context) => context.name === newContext);
      if (!context) {
        error(options, `Context "${newContext}" not found`);
      }

      contextIds.push(context.id);
    }

    await trpcClient.mutation("envVarsContexts.updateEnvVars", {
      org,
      add: [],
      update: [{
        id: envVar.id,
        context_ids: newContexts.length === 0 ? null : contextIds,
      }],
      remove: [],
    });

    if (options.json) {
      writeJsonResult(
        await fetchShapedEnvVar(options, trpcClient, org, app, variable),
      );
      return;
    }

    console.error(
      `${
        green("✔")
      } The contexts of environment variable '${variable}' have been successfully updated.`,
    );
  }));

const envDeleteCommand = new Command<EnvCommandContext>()
  .description("Delete an environment variable in the application")
  .arguments("variable:string")
  .action(actionHandler(async (config, options, variable) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    const envVars = await trpcClient.query("envVarsContexts.list", {
      org,
      app,
    }) as EnvVar[];

    const envVar = envVars.find((envVar) => envVar.key === variable);

    if (!envVar) {
      error(
        options,
        `Environment variable '${variable}' not found.\nUse 'env list' to see available variables.`,
      );
    }

    await trpcClient.mutation("envVarsContexts.updateEnvVars", {
      org,
      add: [],
      update: [],
      remove: [envVar.id],
    });

    if (options.json) {
      writeJsonResult({ id: envVar.id, key: variable, deleted: true });
      return;
    }

    console.error(
      `${
        green("✔")
      } Environment variable '${variable}' has been successfully deleted.`,
    );
  }));

const PUBLIC_REGEX = /^PUBLIC_|^NEXT_PUBLIC_/;

const COMMON_SECRET_PATTERN =
  /^(?!.*(?:^|_)(PUBLIC|NEXT_PUBLIC|EXPOSED)(?:_|$)).*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIALS|AUTH)(?![A-Za-z])/i;

function isSecretKey(key: string): boolean {
  return COMMON_SECRET_PATTERN.test(key);
}

const envLoadCommand = new Command<EnvCommandContext>()
  .description(
    "Load environment variables from a .env file into the application",
  )
  .option(
    "--non-secrets <keys...:string>",
    "Which keys in the .env file to treat as non-secrets",
  )
  .option(
    "--replace",
    "Replace existing env vars without prompting",
  )
  .option(
    "--skip-existing",
    "Skip existing env vars without prompting",
  )
  .arguments("<file:string>")
  .example("Load from .env file", "load .env")
  .example("Replace existing variables", "load --replace .env.production")
  .action(actionHandler(async (config, options, file) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    const fullApp = await trpcClient.query("apps.get", { org, app }) as {
      id: string;
    };

    const variables = dotEnvParse(await Deno.readTextFile(file));

    const existingEnvVars = await trpcClient.query(
      "envVarsContexts.list",
      { org, app },
    ) as EnvVar[];

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

    const existingKeys = updateEnvVars.map((envVar) => envVar.key);

    if (updateEnvVars.length > 0) {
      if (options.skipExisting) {
        updateEnvVars = [];
      } else if (options.replace) {
        // proceed with updates
      } else if (isNonInteractive(options)) {
        error(
          options,
          "Existing env vars found and prompting is disabled.\nUse --replace to overwrite or --skip-existing to skip.",
        );
      } else {
        console.error("The following env vars are already defined:");
        for (const updateEnvVar of updateEnvVars) {
          console.error(` - ${updateEnvVar.key}`);
        }
        console.error();
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
                error(options, "Env vars are already defined, exiting");
              }
              case "s": {
                updateEnvVars = [];
                break outer;
              }
            }
          }
        }
        console.error();
      }
    }

    await trpcClient.mutation("envVarsContexts.updateEnvVars", {
      org,
      add: addEnvVars,
      update: updateEnvVars,
      remove: [],
    });

    const added = addEnvVars.map((envVar) => envVar.key);
    const updated = updateEnvVars.map((envVar) => envVar.key);
    const skipped = existingKeys.filter((key) => !updated.includes(key));

    if (options.json) {
      writeJsonResult({ file, added, updated, skipped });
      return;
    }

    console.error(
      `${green("✔")} .env file '${file}' has been successfully loaded.`,
    );
  }));

export const envCommand = new Command<GlobalContext>()
  .description("Modify environment variables")
  .globalOption("--org <name:string>", "The name of the organization")
  .globalOption("--app <name:string>", "The name of the application")
  .action(() => {
    envCommand.showHelp();
  })
  .command("list", envListCommand)
  .alias("ls")
  .command("add", envAddCommand)
  .command("update-value", envUpdateValueCommand)
  .command("update-contexts", envUpdateContextsCommand)
  .command("delete", envDeleteCommand)
  .alias("remove")
  .alias("rm")
  .command("load", envLoadCommand);
