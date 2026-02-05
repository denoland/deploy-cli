import { Command, ValidationError } from "@cliffy/command";
import { red, yellow } from "@std/fmt/colors";
import { create, error, renderTemporalTimestamp } from "../util.ts";
import { createSwitchCommand, type GlobalContext } from "../main.ts";
import { actionHandler, getApp, getOrg } from "../config.ts";
import { publish } from "./publish.ts";
import { setupAws, setupGcp } from "./setup-cloud.ts";
import { createTrpcClient, getAuth, tokenStorage } from "../auth.ts";
import { databasesCommand } from "./database.ts";
import { envCommand } from "./env.ts";

const createCommand = new Command<GlobalContext>()
  .description("Create a new application")
  .option(
    "--allow-node-modules",
    "Allow node_modules directory to be included when uploading",
  )
  .option(
    "--org <name:string>",
    "The name of the organization to create the application for",
  )
  .option("--no-wait", "Skip waiting for the build to complete")
  .arguments("[root-path:string]")
  .action(actionHandler(async (config, options, rootPath = Deno.cwd()) => {
    const org = await getOrg(options, config, options.org);

    if (config.app) {
      error(options, "An application already exists in this directory.");
    }

    const newOrgAndApp = await create(
      options,
      rootPath,
      org,
    );

    await publish(
      options,
      rootPath,
      newOrgAndApp.org,
      newOrgAndApp.app,
      true,
      options.allowNodeModules ?? false,
      options.wait ?? true,
    );
  }, (rootPath) => rootPath));

const setupAWSCommand = new Command<GlobalContext>()
  .description("Setup cloud connections for AWS")
  .option("--org <name:string>", "The name of the organization", {
    required: true,
  })
  .option("--app <name:string>", "The name of the application", {
    required: true,
  })
  .arguments("[contexts:string]")
  .action(actionHandler(async (config, options, contexts) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupAws(options, org, app, contextList);
  }));

const setupGCPCommand = new Command<GlobalContext>()
  .description("Setup cloud connections for GCP")
  .option("--org <name:string>", "The name of the organization", {
    required: true,
  })
  .option("--app <name:string>", "The name of the application", {
    required: true,
  })
  .arguments("[contexts:string]")
  .action(actionHandler(async (config, options, contexts) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupGcp(options, org, app, contextList);
  }));

const tunnelLoginCommand = new Command<GlobalContext>()
  .option("--really-no-config", "really no config")
  .option("--out <file:string>", "out file")
  .hidden()
  .action(actionHandler(async (config, options) => {
    const org = await getOrg(options, config, undefined);
    const { app } = await getApp(options, config, false, org, undefined);

    const token = await getAuth(options);

    if (options.reallyNoConfig === true) {
      config.noSave();
    }

    if (options.out) {
      await Deno.writeTextFile(
        options.out,
        JSON.stringify({ org, app, token }),
      );
    }
  }));

const logsCommand = new Command<GlobalContext>()
  .description("Stream logs from an application")
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .option("--start <date:string>", "The starting timestamp of the logs")
  .option("--end <date:string>", "The ending timestamp of the logs", {
    depends: ["start"],
  })
  .action(actionHandler(async (config, options) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const trpcClient = createTrpcClient(options);

    interface LogEntry {
      Timestamp: string;
      TraceId: string;
      SpanId: string;
      SeverityText: string;
      SeverityNumber: number;
      Body: string;
      ScopeName: string;
      ScopeVersion: string;
      LogAttributes: Record<string, string>;
      Revision: string;
    }

    const seenIds = new Set();
    let onceConnected = false;

    const sub = await trpcClient.subscription(
      "apps.logs",
      {
        org,
        app,
        start: (options.start ? new Date(options.start) : new Date())
          .toISOString(),
        end: options.end ? new Date(options.end).toISOString() : undefined,
        filter: {},
      },
      {
        onData: (data: unknown) => {
          const typedData = data as "streaming" | null | LogEntry[];
          if (typedData === "streaming") {
            if (!onceConnected) {
              console.log("connected, streaming logs...");
            }
            onceConnected = true;
          } else if (Array.isArray(typedData)) {
            for (const log of typedData) {
              const id = log.LogAttributes["log.record.uid"];

              if (seenIds.has(id)) {
                continue;
              } else {
                seenIds.add(id);
              }

              const prefix = `[${renderTemporalTimestamp(log.Timestamp)}${
                log.TraceId ? ` (${log.TraceId})` : ""
              }]`;
              let text = `${prefix} ${log.Body}`;
              if (text.endsWith("\n")) {
                text = text.slice(0, -1);
              }
              text = text.replaceAll("\n", "\n".padEnd(prefix.length + 1));

              if (log.SeverityNumber >= 17) {
                console.log(red(text));
              } else if (log.SeverityNumber >= 13) {
                console.log(yellow(text));
              } else {
                console.log(text);
              }
            }
          }
        },
        onError: (err: unknown) => {
          sub.unsubscribe();
          error(options, Deno.inspect(err));
        },
        onStopped: () => {
          sub.unsubscribe();
        },
      },
    );
  }));

const logoutCommand = new Command()
  .description("Revoke the Deno Deploy token if one is present")
  .action(() => {
    tokenStorage.remove();
    console.log("Successfully logged out");
  });

export const deployCommand = new Command()
  .name("deno deploy")
  .description(`Interact with Deno Deploy

Calling this subcommand without any further subcommands will
deploy your local directory to the specified application.`)
  .globalOption("--endpoint <endpoint:string>", "the endpoint", {
    default: "https://console.deno.com",
    hidden: true,
  })
  .globalOption("--debug", "Enable debug output", {
    hidden: true,
    default: false,
  })
  .globalOption("--token <token:string>", "Auth token to use")
  .globalOption("--config <config:string>", "Path for the config file")
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .option("--prod", "Deploy directly to production")
  .option(
    "--allow-node-modules",
    "Allow node_modules directory to be included when uploading",
  )
  .option("--no-wait", "Skip waiting for the build to complete")
  .arguments("[root-path:string]")
  .globalAction((options) => {
    const endpoint = Deno.env.get("DENO_DEPLOY_ENDPOINT");
    if (endpoint) {
      options.endpoint = endpoint;
    }
    if (options.endpoint.endsWith("/")) {
      throw new ValidationError(
        "The provided DENO_DEPLOY_ENDPOINT is invalid.",
      );
    }

    const tokenEnv = options.token || Deno.env.get("DENO_DEPLOY_TOKEN");
    if (tokenEnv) {
      tokenStorage.set(tokenEnv, true);
    }
  })
  .action(
    actionHandler(
      async (config, options, rootPath = Deno.cwd()) => {
        const org = await getOrg(options, config, options.org);
        const { app, created } = await getApp(
          options,
          config,
          false,
          org,
          options.app,
        );

        await publish(
          options,
          rootPath,
          org,
          app,
          created,
          options.allowNodeModules ?? false,
          options.wait ?? true,
        );
      },
      (rootPath) => rootPath,
    ),
  )
  .command("create", createCommand)
  .command("env", envCommand)
  .command("database", databasesCommand)
  .command("logs", logsCommand)
  .command("setup-aws", setupAWSCommand)
  .command("setup-gcp", setupGCPCommand)
  .command("tunnel-login", tunnelLoginCommand)
  .command("switch", createSwitchCommand(true))
  .command("logout", logoutCommand);
