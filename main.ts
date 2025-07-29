import { Command } from "@cliffy/command";
import { publish } from "./publish.ts";
import { red, yellow } from "@std/fmt/colors";
import { greaterOrEqual, parse as semverParse } from "@std/semver";
import { create } from "./create.ts";
import { error, renderTemporalTimestamp, withApp } from "./util.ts";
import { setupAws, setupGcp } from "./setup-cloud.ts";
import { getAppFromConfig, readConfig, writeConfig } from "./config.ts";
import {
  envAddCommand,
  envDeleteCommand,
  envListCommand,
  envLoadCommand,
  envUpdateContextsCommand,
  envUpdateValueCommand,
} from "./env.ts";
import { createTrpcClient } from "./auth.ts";

const MINIMUM_DENO_VERSION = "2.4.2";
if (
  !greaterOrEqual(
    semverParse(Deno.version.deno),
    semverParse(MINIMUM_DENO_VERSION),
  )
) {
  error(
    `Minimum Deno version required is ${MINIMUM_DENO_VERSION} (found ${Deno.version.deno}).`,
  );
}

const createCommand = new Command<{ endpoint: string }>()
  .description("Create a new application")
  .option(
    "--org <name:string>",
    "The name of the organization to create the application for",
  )
  .arguments("[root-path:string]")
  .action(
    async (
      { endpoint, org: initOrg },
      rootPath = Deno.cwd(),
    ) => {
      const configContent = await readConfig(rootPath);
      const { org, app } = getAppFromConfig(configContent);
      if (org || app) {
        console.log(
          `${red("✗")} An application already exists in this directory.`,
        );
        Deno.exit(1);
      }

      await create(endpoint, rootPath, configContent, initOrg);
    },
  );

const setupAWSCommand = new Command<{ endpoint: string }>()
  .description("Setup AWS")
  .option("--org <name:string>", "The name of the organization", {
    required: true,
  })
  .option("--app <name:string>", "The name of the application", {
    required: true,
  })
  .arguments("[contexts:string]")
  .action(async (options, contexts) => {
    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];
    const gottenApp = await withApp(
      options.endpoint,
      false,
      options.org,
      options.app,
    );
    await setupAws(options.endpoint, gottenApp.org, gottenApp.app, contextList);
  });

const setupGCPCommand = new Command<{ endpoint: string }>()
  .description("Setup GCP")
  .option("--org <name:string>", "The name of the organization", {
    required: true,
  })
  .option("--app <name:string>", "The name of the application", {
    required: true,
  })
  .arguments("[contexts:string]")
  .action(async (options, contexts) => {
    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];
    const gottenApp = await withApp(
      options.endpoint,
      false,
      options.org,
      options.app,
    );
    await setupGcp(options.endpoint, gottenApp.org, gottenApp.app, contextList);
  });

const tunnelLoginCommand = new Command<{ endpoint: string }>()
  .arguments("[root-path:string]")
  .hidden()
  .action(async (options, rootPath = Deno.cwd()) => {
    const configContent = await readConfig(rootPath);
    const { org, app } = getAppFromConfig(configContent);
    const gottenApp = await withApp(options.endpoint, false, org, app);
    await writeConfig(configContent, rootPath, gottenApp.org, gottenApp.app);
  });

const envCommand = new Command<{ endpoint: string }>()
  .description("Modify environmental variables")
  .globalOption("--org <name:string>", "The name of the organization")
  .globalOption("--app <name:string>", "The name of the application")
  .action(() => {
    envCommand.showHelp();
  })
  .command("list", envListCommand)
  .command("add", envAddCommand)
  .command("update-value", envUpdateValueCommand)
  .command("update-contexts", envUpdateContextsCommand)
  .command("delete", envDeleteCommand)
  .command("load", envLoadCommand);

const logsCommand = new Command<{ endpoint: string }>()
  .description("Stream logs from an application")
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .option("--start <date:string>", "The starting timestamp of the logs")
  .option("--end <date:string>", "The ending timestamp of the logs", {
    depends: ["start"],
  })
  .action(async (options, rootPath = Deno.cwd()) => {
    const configContent = await readConfig(rootPath);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;
    const gottenApp = await withApp(options.endpoint, false, org, app);

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

    const trpcClient = createTrpcClient(options.endpoint);

    const seenIds = new Set();
    let onceConnected = false;

    // deno-lint-ignore no-explicit-any
    const sub = await (trpcClient.apps as any).logs.subscribe({
      org: gottenApp.org,
      app: gottenApp.app,
      start: (options.start ? new Date(options.start) : new Date())
        .toISOString(),
      end: options.end ? new Date(options.end).toISOString() : undefined,
      filter: {},
    }, {
      onData: (data: "streaming" | null | LogEntry[]) => {
        if (data === "streaming") {
          if (!onceConnected) {
            console.log("connected, streaming logs...");
          }
          onceConnected = true;
        } else if (Array.isArray(data)) {
          for (const log of data) {
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
        error(Deno.inspect(err));
      },
      onStopped: () => {
        sub.unsubscribe();
      },
    });
  });

await new Command()
  .name("deno deploy")
  .description(`Interact with Deno Deploy
  
Calling this subcommand without any further subcommands will
deploy your local directory to the specified application.`)
  .globalOption("--endpoint <endpoint:string>", "the endpoint", {
    default: "https://app.deno.com",
    hidden: true,
  })
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .option("--prod", "Deploy directly to production")
  .arguments("[root-path:string]")
  .action(
    async (
      options,
      rootPath = Deno.cwd(),
    ) => {
      const configContent = await readConfig(rootPath);
      let { org, app } = getAppFromConfig(configContent);
      org ??= options.org;
      app ??= options.app;

      const orgAndApp = await withApp(
        options.endpoint as string,
        true,
        org,
        app,
      );

      if (orgAndApp.app === null) {
        await create(
          options.endpoint as string,
          rootPath,
          configContent,
          orgAndApp.org,
        );
      } else {
        await publish(
          options.endpoint as string,
          rootPath,
          configContent,
          orgAndApp.org,
          orgAndApp.app,
          options.prod ?? false,
        );
      }
    },
  )
  .command("create", createCommand)
  .command("env", envCommand)
  .command("logs", logsCommand)
  .command("setup-aws", setupAWSCommand)
  .command("setup-gcp", setupGCPCommand)
  .command("tunnel-login", tunnelLoginCommand)
  .parse(Deno.args);
