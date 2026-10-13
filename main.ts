import { Command, ValidationError } from "@cliffy/command";
import { greaterOrEqual, parse as semverParse } from "@std/semver";
import { sandboxCommand } from "./sandbox/mod.ts";
import { deployCommand } from "./deploy/mod.ts";
import { actionHandler, getApp, getOrg } from "./config.ts";
import { helpJson } from "./help-json.ts";
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

// `.reset()` repoints the builder to the root command before `.noExit()`, which
// makes Cliffy throw parse errors instead of exiting so `handleCliError` can map them.
try {
  // deno-lint-ignore no-explicit-any
  const root: Command<any> = Deno.env.has("DENO_DEPLOY_CLI_SANDBOX")
    ? sandboxCommand.reset()
    : deployCommand.command("sandbox", sandboxCommand).reset();

  // Handled before parsing: the addressed command may declare required options
  // that would otherwise reject a pure introspection call.
  if (Deno.args.includes("--help-json")) {
    writeJsonResult(helpJson(root, Deno.args));
    Deno.exit(ExitCode.OK);
  }

  await root.noExit().parse(Deno.args);
} catch (e) {
  handleCliError(e);
}

// Maps an error thrown out of `parse()` to the CLI error contract (ValidationError -> USAGE).
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

// Parse-free `--json` detection: matches `--json`, `--json=...`, `-j`, and bundles like `-jy`.
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
