import { Command, ValidationError } from "@cliffy/command";
import { greaterOrEqual, parse as semverParse } from "@std/semver";
import { sandboxCommand } from "./sandbox/mod.ts";
import { deployCommand } from "./deploy/mod.ts";
import { actionHandler, getApp, getOrg } from "./config.ts";
import { error, ExitCode, writeJsonResult } from "./util.ts";

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
  quiet?: true;
  /** Emit JSON to stdout (single object/array per command) and structured errors to stderr. */
  json?: true;
  /** Refuse interactive prompts; missing inputs must come from flags/env. */
  nonInteractive?: true;
};

// `.noExit()` makes Cliffy throw parse errors instead of exiting, so they can be
// routed through the CLI error contract (see `handleCliError`). It also stops
// `--help`/`--version` from exiting: Cliffy prints them and `parse()` returns, so
// the process still exits 0. `.reset()` first repoints the builder back to the
// root command (mounting/defining subcommands leaves it selecting a child), so
// `.noExit()` applies to the command we actually parse.
try {
  if (Deno.env.has("DENO_DEPLOY_CLI_SANDBOX")) {
    await sandboxCommand.reset().noExit().parse(Deno.args);
  } else {
    await deployCommand.command("sandbox", sandboxCommand).reset().noExit()
      .parse(Deno.args);
  }
} catch (e) {
  handleCliError(e);
}

/**
 * Map an error thrown out of Cliffy's `parse()` onto the CLI error contract.
 * `ValidationError` (unknown/invalid/conflicting flag, missing value) is a usage
 * error and must exit with `ExitCode.USAGE` (2); anything else is generic.
 */
function handleCliError(e: unknown): never {
  const context: GlobalContext = {
    debug: Deno.args.includes("--debug"),
    endpoint: "",
    json: Deno.args.some(isJsonModeArg) ? true : undefined,
  };

  if (e instanceof ValidationError) {
    error(context, e.message, {
      code: ExitCode.USAGE,
      errorCode: "VALIDATION_ERROR",
    });
  }

  error(context, e instanceof Error ? e.message : String(e));
}

/**
 * Best-effort `--json` detection without a parsed context, used by
 * `handleCliError` to pick the error output format when `parse()` itself throws.
 * Matches `--json`, `--json=...`, `-j`, and combined short flags like `-jy`.
 */
function isJsonModeArg(arg: string): boolean {
  return arg === "-j" || arg === "--json" || arg.startsWith("--json=") ||
    /^-[a-z]*j[a-z]*$/.test(arg);
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
        writeJsonResult({ org, app: app ?? null });
      } else {
        console.error(
          `Switched to organization '${org}'${
            app ? ` and application '${app}'` : ""
          }.`,
        );
      }
    }));
}
