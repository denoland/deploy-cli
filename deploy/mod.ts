import { Command, ValidationError } from "@cliffy/command";
import { green, red, setColorEnabled, yellow } from "@std/fmt/colors";
import {
  deployRootDir,
  error,
  ExitCode,
  renderTemporalTimestamp,
  tablePrinter,
  writeJsonResult,
} from "../util.ts";
import { createSwitchCommand, type GlobalContext } from "../main.ts";
import { VERSION } from "../version.ts";
import { actionHandler, getApp, getOrg } from "../config.ts";
import { publish } from "./publish.ts";
import { setupAws, setupGcp } from "./setup-cloud.ts";
import { createTrpcClient, getAuth, tokenStorage } from "../auth.ts";
import { databasesCommand } from "./database.ts";
import { envCommand } from "./env.ts";
import { createCommand } from "./create/mod.ts";
import { appsCommand } from "./apps.ts";
import { orgsCommand } from "./orgs.ts";
import { deploymentsCommand } from "./deployments.ts";

const setupAWSCommand = new Command<GlobalContext>()
  .description("Setup cloud connections for AWS")
  .option("--org <name:string>", "The name of the organization", {
    required: true,
  })
  .option("--app <name:string>", "The name of the application", {
    required: true,
  })
  .option(
    "--policies <arn:string>",
    "IAM policy ARN to attach to the new role (repeatable; bypasses the interactive policy picker)",
    { collect: true },
  )
  .option(
    "--role-name <name:string>",
    "Name for the IAM role to create (omit for a random-suffixed default; pass to allow idempotent re-runs)",
  )
  .option(
    "--apply",
    "Authorize creating/modifying the cloud resources without a confirmation prompt (required in --non-interactive mode)",
  )
  .arguments("[contexts:string]")
  .action(actionHandler(async (config, options, contexts) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupAws(options, org, app, contextList, {
      policies: options.policies,
      roleName: options.roleName as unknown as string | undefined,
      apply: options.apply as unknown as boolean | undefined,
    });
  }));

const setupGCPCommand = new Command<GlobalContext>()
  .description("Setup cloud connections for GCP")
  .option("--org <name:string>", "The name of the organization", {
    required: true,
  })
  .option("--app <name:string>", "The name of the application", {
    required: true,
  })
  .option(
    "--roles <role:string>",
    "IAM role to grant to the service account (repeatable; bypasses the interactive role picker)",
    { collect: true },
  )
  .option(
    "--service-account-name <name:string>",
    "Name for the service account to create (omit for a random-suffixed default; pass to allow idempotent re-runs)",
  )
  .option(
    "--enable-apis",
    "Authorize enabling required APIs that are missing (in --non-interactive mode also requires --apply; nothing is enabled without it)",
  )
  .option(
    "--apply",
    "Authorize creating/modifying cloud resources without a confirmation prompt (required in --non-interactive mode; API enablement is separately governed by --enable-apis)",
  )
  .arguments("[contexts:string]")
  .action(actionHandler(async (config, options, contexts) => {
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);

    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupGcp(options, org, app, contextList, {
      roles: options.roles,
      serviceAccountName: options.serviceAccountName as unknown as
        | string
        | undefined,
      enableApis: options.enableApis as unknown as boolean | undefined,
      apply: options.apply as unknown as boolean | undefined,
    });
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
  .option(
    "--once",
    "Capture currently-available (backfilled) logs, then exit instead of tailing live. Bounded, non-interactive capture for CI/agents; defaults to the last hour, widen with --start.",
  )
  .example(
    "Stream live logs",
    "logs --app my-app",
  )
  .example(
    "View logs from a specific time",
    "logs --app my-app --start '2025-01-01T00:00:00Z'",
  )
  .example(
    "Capture current logs then exit (CI/agents)",
    "logs --app my-app --once --json --non-interactive",
  )
  .action(actionHandler(async (config, options) => {
    // Read-only: don't create a deno.jsonc (its stdout notice breaks --json).
    config.noCreate();
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

    // --once without --start defaults to the last hour (a `new Date()` start
    // would request an empty window with nothing to drain).
    const ONCE_LOOKBACK_MS = 60 * 60 * 1000;
    const startDate = options.start
      ? new Date(options.start)
      : options.once
      ? new Date(Date.now() - ONCE_LOOKBACK_MS)
      : new Date();

    const encoder = new TextEncoder();
    const sub = trpcClient.subscription(
      "apps.logs",
      {
        org,
        app,
        start: startDate.toISOString(),
        end: options.end ? new Date(options.end).toISOString() : undefined,
        filter: {},
      },
      {
        onData: (data: unknown) => {
          const typedData = data as "streaming" | null | LogEntry[];
          if (typedData === "streaming") {
            // End of backfill: in --once mode, stop before live tailing.
            if (options.once) {
              sub.unsubscribe();
              Deno.exit(ExitCode.OK);
            }
            if (!onceConnected && !options.quiet && !options.json) {
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

              if (options.json) {
                // NDJSON: one record per line on stdout, severity preserved as
                // a numeric field so agents can filter without re-parsing.
                Deno.stdout.writeSync(encoder.encode(
                  JSON.stringify({
                    timestamp: log.Timestamp,
                    traceId: log.TraceId || null,
                    spanId: log.SpanId || null,
                    severity: log.SeverityText,
                    severityNumber: log.SeverityNumber,
                    body: log.Body,
                    scope: log.ScopeName,
                    revision: log.Revision,
                    attributes: log.LogAttributes,
                  }) + "\n",
                ));
                continue;
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
          // Server-completed stream (e.g. a bounded --start/--end window).
          if (options.once) {
            Deno.exit(ExitCode.OK);
          }
        },
      },
    );
  }));

const logoutCommand = new Command()
  .description("Revoke the Deno Deploy token if one is present")
  .action(() => {
    tokenStorage.remove();
    console.error(`${green("✔")} Successfully logged out`);
  });

interface WhoamiOrg {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
}

interface AccountMe {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
    githubLogin: string | null;
  } | null;
  tokenType: string;
}

const whoamiCommand = new Command<GlobalContext>()
  .description(
    "Verify the current Deno Deploy token and list reachable organizations",
  )
  .example(
    "Check that DENO_DEPLOY_TOKEN works",
    "whoami --json",
  )
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    // Touch tokenStorage via the tRPC client; this will surface a clean
    // AUTH_INVALID_TOKEN envelope from the errorLink if the token is bad,
    // without ever calling `requireInteractive()` or opening a browser.
    const trpcClient = createTrpcClient(options);
    const [me, orgs] = await Promise.all([
      trpcClient.query("account.me") as Promise<AccountMe>,
      trpcClient.query("orgs.list") as Promise<WhoamiOrg[]>,
    ]);

    if (options.json) {
      writeJsonResult({
        authenticated: true,
        user: me.user,
        tokenType: me.tokenType,
        orgs: orgs.map((org) => ({
          id: org.id,
          slug: org.slug,
          name: org.name,
          plan: org.plan,
        })),
      });
      return;
    }

    const who = me.user
      ? (me.user.githubLogin
        ? `@${me.user.githubLogin}`
        : me.user.email ?? me.user.name ?? me.user.id)
      : `org-scoped token (${me.tokenType})`;
    console.error(
      `${
        green("✔")
      } Authenticated as ${who}. ${orgs.length} reachable organization${
        orgs.length === 1 ? "" : "s"
      }:`,
    );
    if (orgs.length > 0) {
      tablePrinter(
        ["SLUG", "NAME", "PLAN"],
        orgs,
        (org) => [org.slug, org.name, org.plan ?? "—"],
      );
    }
  }));

export const deployCommand = new Command()
  .name("deno deploy")
  .version(VERSION)
  .description(`Interact with Deno Deploy

Calling this subcommand without any further subcommands will
deploy your local directory to the specified application.

For non-interactive use (CI, AI agents), authenticate via the
DENO_DEPLOY_TOKEN env var (or --token) and pass --json --non-interactive
to every subcommand. The CLI then emits a single JSON object on stdout,
a structured { error: { code, message, hint } } envelope on stderr,
and a stable exit code (0 OK, 1 GENERIC, 2 USAGE, 3 AUTH, 4 NOT_FOUND,
5 CONFLICT, 6 NETWORK). See https://docs.deno.com/runtime/reference/cli/deploy/#agent--ci-usage
for the full reference.`)
  .example(
    "Verify the active token",
    "whoami --json",
  )
  .example(
    "Deploy current directory non-interactively",
    "--json --non-interactive --org my-org --app my-app --prod",
  )
  .example(
    "Create a static app from CI",
    "create --json --non-interactive --org my-org --app my-app --source local --runtime-mode static --static-dir dist --region us",
  )
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
  .globalOption("--ignore <path:string>", "Ignore particular source files", {
    collect: true,
  })
  .globalOption("-q, --quiet", "Suppress non-essential output")
  .globalOption(
    "-j, --json",
    "Emit JSON on stdout instead of human-readable output",
  )
  .globalOption(
    "-y, --non-interactive",
    "Fail fast instead of prompting; values must be supplied via flags or env vars (alias: -y)",
  )
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

    // `--json` implies machine-readable output: kill ANSI color so structured
    // payloads piped to `jq` don't carry escape sequences.
    if (options.json) {
      setColorEnabled(false);
    }

    if (options.debug) {
      console.error(
        yellow(
          `Debug mode is enabled (deno ${Deno.version.deno}, @deno/deploy ${VERSION}, endpoint=${options.endpoint})`,
        ),
      );
    }
  })
  .action(
    actionHandler(
      async (config, options, rawRootPath = Deno.cwd()) => {
        // A positional file argument (e.g. `main.ts`) deploys its directory.
        const rootPath = deployRootDir(rawRootPath);
        const org = await getOrg(options, config, options.org);
        const { app, created } = await getApp(
          options,
          config,
          true,
          org,
          options.app,
          rootPath,
        );

        if (!created) {
          await publish(
            options,
            config,
            rootPath,
            org,
            app,
            options.prod ?? false,
            options.wait ?? true,
          );
        }

        // Persist resolved org/app now; actionHandler's post-action save()
        // would otherwise be skipped by the forced exit below.
        await config.save();

        // The deploy has finished successfully. Force a clean exit: the tRPC
        // client used for the upload/`revisions.watchUntilReady` subscription
        // keeps handles open (the EventSource polyfill's connection + reconnect
        // timer, and the streaming upload request), so without this the process
        // hangs indefinitely after printing "Successfully deployed" — turning a
        // successful deploy into a job that runs until its CI timeout. Mirrors
        // the explicit `Deno.exit(1)` on the failure path in publish.ts.
        Deno.exit(0);
      },
      (rootPath) => rootPath,
    ),
  )
  .command("create", createCommand)
  .command("env", envCommand)
  .command("database", databasesCommand)
  .command("apps", appsCommand)
  .command("orgs", orgsCommand)
  .command("deployments", deploymentsCommand)
  .command("logs", logsCommand)
  .command("setup-aws", setupAWSCommand)
  .command("setup-gcp", setupGCPCommand)
  .command("tunnel-login", tunnelLoginCommand)
  .command("switch", createSwitchCommand(true))
  .command("logout", logoutCommand)
  .command("whoami", whoamiCommand);
