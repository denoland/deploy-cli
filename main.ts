import { Command } from "@cliffy/command";
import { greaterOrEqual, parse as semverParse } from "@std/semver";
import { sandboxCommand } from "./sandbox/mod.ts";
import { deployCommand } from "./deploy/mod.ts";
import { actionHandler, getApp, getOrg } from "./config.ts";
import { jsonOutput } from "./util.ts";

const MINIMUM_DENO_VERSION = "2.4.2";
if (
  !greaterOrEqual(
    semverParse(Deno.version.deno),
    semverParse(MINIMUM_DENO_VERSION),
  )
) {
  throw new Error(
    `Minimum Deno version required is ${MINIMUM_DENO_VERSION} (found ${Deno.version.deno}).`,
  );
}

export type GlobalContext = {
  debug: boolean;
  endpoint: string;
  token?: string;
  config?: string;
  ignore?: string[];
  allowNodeModules?: boolean;
  json?: boolean;
  quiet?: boolean;
};

if (Deno.env.has("DENO_DEPLOY_CLI_SANDBOX")) {
  await sandboxCommand.parse(Deno.args);
} else {
  await deployCommand.command("sandbox", sandboxCommand).parse(Deno.args);
}

export function createSwitchCommand(
  handleApp: boolean,
): Command<GlobalContext> {
  return new Command<GlobalContext>()
    .description("Switch between organizations and applications")
    .option("--org <name:string>", "The name of the organization")
    .option("--app <name:string>", "The name of the application")
    .action(actionHandler(async (config, options) => {
      const org = await getOrg(options, config, options.org);

      let app;
      if (handleApp) {
        const out = await getApp(options, config, false, org, options.app);
        app = out.app;
      }

      if (options.json) {
        jsonOutput({ org, app: app ?? undefined });
      } else {
        console.log(
          `Switched to organization '${org}'${
            app ? ` and application '${app}'` : ""
          }.`,
        );
      }
    }));
}
