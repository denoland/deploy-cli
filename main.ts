import { Command } from "@cliffy/command";
import { publish } from "./publish.ts";
import { red } from "@std/fmt/colors";
import { create } from "./create.ts";
import { withApp } from "./util.ts";
import { setupAws, setupGcp } from "./setup-cloud.ts";
import { getAppFromConfig, readConfig, writeConfig } from "./config.ts";

const createCommand = new Command<{ endpoint: string }>()
  .option("--org <name:string>", "The name of the org to create the app for")
  .arguments("[root-path:string]")
  .action(
    async (
      { endpoint, org: initOrg },
      rootPath = Deno.cwd(),
    ) => {
      const configContent = await readConfig(rootPath);
      const { org, app } = getAppFromConfig(configContent);
      if (org || app) {
        console.log(`${red("✗")} An app already exists in this directory.`);
        Deno.exit(1);
      }

      await create(endpoint, rootPath, configContent, initOrg);
    },
  );

const setupAWSCommand = new Command<{ endpoint: string }>()
  .option("--org <name:string>", "The name of the org", { required: true })
  .option("--app <name:string>", "The name of the app", { required: true })
  .arguments("[contexts:string]")
  .action(async (options, contexts) => {
    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupAws(options.org, options.app, contextList);
  });

const setupGCPCommand = new Command<{ endpoint: string }>()
  .option("--org <name:string>", "The name of the org", { required: true })
  .option("--app <name:string>", "The name of the app", { required: true })
  .arguments("[contexts:string]")
  .action(async (options, contexts) => {
    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupGcp(options.org, options.app, contextList);
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

await new Command()
  .globalOption("--endpoint <endpoint:string>", "the endpoint", {
    default: "https://app.deno.com",
    hidden: true,
  })
  .option("--org <name:string>", "The name of the org")
  .option("--app <name:string>", "The name of the app")
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

      const orgAndApp = await withApp(options.endpoint as string, true, org, app);

      if (orgAndApp.app === null) {
        await create(options.endpoint as string, rootPath, configContent, orgAndApp.org);
      } else {
        await publish(
          options.endpoint as string,
          rootPath,
          configContent,
          orgAndApp.org,
          orgAndApp.app,
        );
      }
    },
  )
  .command("create", createCommand)
  .command("setup-aws", setupAWSCommand)
  .command("setup-gcp", setupGCPCommand)
  .command("tunnel-login", tunnelLoginCommand)
  .parse(Deno.args);
