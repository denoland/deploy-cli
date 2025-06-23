import { Command } from "@cliffy/command";
import { publish } from "./publish.ts";
import { red } from "@std/fmt/colors";
import { create } from "./create.ts";
import { withApp } from "./util.ts";
import { setupAws } from "./setup-cloud.ts";
import { getAppFromConfig, readConfig } from "./config.ts";

const createCommand = new Command()
  .option("--org <string:name>", "The name of the org to create the app for")
  .arguments("[rootPath:string]")
  .action(
    async (
      { endpoint, org: initOrg }: { endpoint: string; org?: string },
      rootPath: string = Deno.cwd(),
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

const setupAWSCommand = new Command()
  .option("--org <string:name>", "The name of the org", { required: true })
  .option("--app <string:name>", "The name of the app", { required: true })
  .arguments("[contexts:string]")
  .action(async (options: { org: string; app: string }, contexts?: string) => {
    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupAws(options.org, options.app, contextList);
  });

await new Command()
  .globalOption("--endpoint [endpoint:string]", "the endpoint", {
    default: "https://app.deno.com",
    hidden: true,
  })
  .option("--org <string:name>", "The name of the org")
  .option("--app <string:name>", "The name of the app")
  .action(
    async (
      options: { endpoint: string; org?: string; app?: string },
      rootPath: string = Deno.cwd(),
    ) => {
      const configContent = await readConfig(rootPath);
      let { org, app } = getAppFromConfig(configContent);
      org ??= options.org;
      app ??= options.app;

      const orgAndApp = await withApp(options.endpoint, org, app);

      if (orgAndApp.app === null) {
        await create(options.endpoint, rootPath, configContent, orgAndApp.org);
      } else {
        await publish(
          options.endpoint,
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
  .parse(Deno.args);
