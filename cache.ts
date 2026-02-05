import { Command } from "@cliffy/command";
import { green } from "@std/fmt/colors";
import { getAppFromConfig, readConfig } from "./config.ts";
import { withApp } from "./util.ts";
import { createTrpcClient } from "./auth.ts";
import type { GlobalOptions } from "./main.ts";

type CacheCommandContext = GlobalOptions & {
  org?: string;
  app?: string;
};

export const cacheInvalidateCommand = new Command<CacheCommandContext>()
  .description("Invalidate cache tags for an application")
  .arguments("<tags...:string>")
  .action(async (options, ...tags) => {
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
    await (trpcClient.apps as any).invalidateCache.mutate({
      org: orgAndApp.org,
      app: orgAndApp.app,
      tags,
    });

    console.log(
      `${green("✓")} Cache invalidated for tags: ${tags.join(", ")}`,
    );
  });

export const cacheCommand = new Command<GlobalOptions>()
  .description("Manage application cache")
  .globalOption("--org <name:string>", "The name of the organization")
  .globalOption("--app <name:string>", "The name of the application")
  .action(() => {
    cacheCommand.showHelp();
  })
  .command("invalidate", cacheInvalidateCommand);
