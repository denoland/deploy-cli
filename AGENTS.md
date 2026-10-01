# Using `deno deploy` from an agent or CI

This CLI is built for humans at a terminal (interactive prompts, OAuth browser
login, colorized output) but every interactive surface has a non-interactive
path so it can be driven by an AI agent, a CI job, or any other automated
caller. This document is the reference for that non-interactive usage.

The two flags you almost always want are `--non-interactive` (never prompt) and
`--json` (machine-readable output). Combine them with a token in the environment
and the CLI runs end-to-end with no TTY and no browser.

## Authentication (no browser)

Set a token in the environment instead of running the OAuth login flow:

```sh
export DENO_DEPLOY_TOKEN=ddp_xxxxxxxxxxxxxxxx   # generate at <endpoint>/account/tokens
```

- When `DENO_DEPLOY_TOKEN` (or `--token <token>`) is set, the CLI uses it
  directly and never opens a browser or prompts for login.
- An invalid or expired token fails with exit code `3` (AUTH) and a message
  telling you to regenerate the token and re-export `DENO_DEPLOY_TOKEN` — it
  does **not** fall back to the browser flow.
- Verify auth without side effects:

  ```sh
  deno deploy whoami --json
  # {"authenticated":true,"user":{...},"tokenType":"...","orgs":[...]}
  ```

## Non-interactive mode

Pass `--non-interactive` (alias `-y`) to make the CLI refuse to prompt. It is
also implied automatically when stdin is not a TTY. In this mode any value that
would have been asked for interactively must be supplied via a flag or env var;
a missing value fails fast with exit code `2` (USAGE) and an error naming the
exact flag to pass, e.g. `Use --org to specify the organization.`

Values that can come from the environment:

| Env var                | Equivalent flag | Used for                        |
| ---------------------- | --------------- | ------------------------------- |
| `DENO_DEPLOY_TOKEN`    | `--token`       | auth token                      |
| `DENO_DEPLOY_ORG`      | `--org`         | default organization slug       |
| `DENO_DEPLOY_APP`      | `--app`         | default application slug        |
| `DENO_DEPLOY_ENDPOINT` | `--endpoint`    | API endpoint (defaults to prod) |

## Structured output (`--json`)

Pass `--json` (alias `-j`) to any command. It emits a single JSON object or
array on **stdout** and nothing else — no spinners, no progress bars, no ANSI
color. Human progress still goes to **stderr**, so
`deno deploy publish --json |
jq` is safe to pipe.

Errors in `--json` mode are emitted as a single object on **stderr**:

```json
{
  "error": { "code": "AUTH", "message": "...", "hint": "...", "traceId": "..." }
}
```

`code` is a stable error identifier when one is known (e.g.
`AUTH_INVALID_TOKEN`, `NON_INTERACTIVE_REQUIRED`, `VALIDATION_ERROR`,
`SLUG_ALREADY_IN_USE`), falling back to the symbolic name of the exit code (see
below); `hint` and `traceId` may be absent. Invalid or unknown flags also
produce this envelope (with exit code `2`), so a bad invocation never emits
free-form text on a `--json` run.

## Exit codes

| Code | Name      | Meaning                                           |
| ---- | --------- | ------------------------------------------------- |
| 0    | OK        | success                                           |
| 1    | GENERIC   | unclassified error                                |
| 2    | USAGE     | missing/invalid flag or argument                  |
| 3    | AUTH      | missing, invalid, or expired token                |
| 4    | NOT_FOUND | org / app / database / resource does not exist    |
| 5    | CONFLICT  | resource already exists (re-running create, etc.) |
| 6    | NETWORK   | backend or network failure                        |

Stack traces are printed only when `--debug` is set; otherwise errors are a
single line (or the JSON envelope above).

## Global flags

These work on every subcommand:

| Flag                    | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `-j, --json`            | Emit JSON on stdout instead of human-readable output |
| `-y, --non-interactive` | Fail fast instead of prompting                       |
| `-q, --quiet`           | Suppress non-essential output                        |
| `--token <token>`       | Auth token (overrides `DENO_DEPLOY_TOKEN`)           |
| `--config <path>`       | Path to the config file                              |
| `--ignore <path>`       | Ignore particular source files (repeatable)          |
| `--debug`               | Enable debug output and stack traces                 |
| `--endpoint <url>`      | API endpoint (hidden from `--help`; no trailing `/`) |
| `--help-json`           | Print the command tree as JSON and exit              |

## Discovering commands and flags

`--help` is human-readable; `--help-json` is the machine-readable equivalent. It
prints one JSON object describing the addressed command — its description,
positional arguments, options (including the inherited globals, each with
`required`, `collect`, `global`, `hidden` and any static `default`), examples,
and its subcommands recursively — then exits `0`. Required options of the
addressed command are not enforced, so introspection never fails.

```sh
# every subcommand name
deno deploy --help-json | jq -r '.commands[].name'

# every flag `deno deploy env add` accepts
deno deploy env add --help-json | jq -r '.options[].flags | join(", ")'

# which flags are required
deno deploy setup-aws --help-json | jq -r '.options[] | select(.required) | .name'
```

## Subcommand flags

Only the agent-relevant flags are listed; run `deno deploy <cmd> --help` for the
full set.

### `deploy` (default / `publish`)

`deno deploy [root-path]` — build and deploy the app in `root-path`.

- `--org <name>`, `--app <name>` — target org/app
- `--prod` — deploy directly to production
- `--no-wait` — return as soon as the build is queued, don't stream it
- `--allow-node-modules` — include `node_modules` when uploading

### `create`

`deno deploy create [root-path]` — create a new application. Supply every flag
to run non-interactively.

- `--org <name>`, `--app <name>`
- `--dry-run` — validate/process flags without creating the app
- `--no-wait`
- `--source <github|local>` and, for github: `--owner <name>`, `--repo <name>`
- `--runtime-mode <dynamic|static>`
  - dynamic: `--entrypoint <file>`, `--arguments <arg>` (repeatable),
    `--working-directory <dir>`
  - static: `--static-dir <dir>`, `--single-page-app`
- `--framework-preset <preset>`, `--install-command`, `--build-command`,
  `--pre-deploy-command`, `--app-directory <path>`
- `--region <region>`, `--build-timeout <minutes>`,
  `--build-memory-limit <megabytes>`

### `env`

All mutations emit a single JSON result object on stdout under `--json`.

- `env list` — list env vars
- `env add <variable> <value> [--secret]`
- `env update-value <variable> <value>`
- `env update-contexts <variable> [new-contexts...]`
- `env delete <variable>`
- `env load <file> [--non-secrets] [--replace | --skip-existing]` —
  `--replace`/`--skip-existing` decide what happens to already-defined keys
  without prompting (required knowledge for non-interactive runs); the `--json`
  result reports `added`/`updated`/`skipped` keys

### `database`

All mutations emit a single JSON result object on stdout under `--json`.

- `database provision <name> --kind <denokv|prisma> [--region <region>]`
- `database link <name> <connectionString>` or
  `database link <name> --hostname <host> [--username --password --port --cert]`
  (the two forms are mutually exclusive; add `--dry-run` to test only)
- `database assign <name> [--app <name>]`
- `database detach <name> [--app <name>]`
- `database list [search]` — for Deno KV databases the `--json` output includes
  `databaseId` and a `connectUrl` usable with `Deno.openKv()`
- `database query <name> <database> [query...]`
- `database delete <name>`

### `logs`

- `logs --once` — drain the currently available (backfilled) logs, then exit 0
  instead of tailing live; defaults to the last hour, widen with
  `--start <iso-date>` (and optionally bound with `--end`). With `--json`,
  output is NDJSON: one log record per line on stdout.

### `sandbox`

- `sandbox create` in non-interactive mode requires an explicit
  `--timeout <duration>` (e.g. `--timeout 15m`): the default `session` timeout
  destroys the sandbox when the command exits. The `--json` result is
  `{id, org, timeout}`; clean up with `sandbox kill <id>`.

### Read-only listings (all support `--json`)

- `apps list [--org <name>] [--limit <n>] [--cursor <c>]`
- `apps get [--org <name>] [--app <name>]` — includes `productionUrl`,
  `domains`, and revision timelines
- `orgs list`
- `deployments list [--org <name>] [--app <name>] [--limit <n>] [--cursor <c>]`
- `whoami`

`--cursor` takes the pagination cursor returned by a previous `--json` run.

## Example flows

All examples assume `DENO_DEPLOY_TOKEN` is exported.

**1. Check auth and resolve the current identity**

```sh
deno deploy whoami --json | jq -r '.user.githubLogin'
```

**2. Create a static site and deploy it**

```sh
deno deploy create ./site \
  --non-interactive --json \
  --org my-org --app my-site \
  --source local --runtime-mode static --static-dir dist --region us
```

**3. Deploy an existing app to production and capture the URL**

```sh
url=$(deno deploy --non-interactive --json --org my-org --app my-site --prod \
  | jq -r '.productionUrl')
echo "deployed to $url"
```

(`.url` is the console build page for the revision; `.productionUrl` is the
served application URL. With `--no-wait` the build is still pending, so only
`revisionId` and `url` are available.)

**4. Set environment variables**

```sh
deno deploy env add API_KEY "$API_KEY" --secret --non-interactive --org my-org --app my-site
deno deploy env list --json --org my-org --app my-site
```

**5. List the most recent deployments as JSON**

```sh
deno deploy deployments list --json --org my-org --app my-site --limit 5
```

## Re-running commands

There are no no-op guarantees. When the backend reports a conflict (HTTP 409),
the CLI exits `5` (CONFLICT) with an error code such as `SLUG_ALREADY_IN_USE`.
Do not blindly treat exit `5` as "already done": the conflicting resource may
belong to someone else or differ from what you tried to create — inspect the
current state (`apps list`, `env list`, `database list`) before deciding.
Partial state is possible: `create` registers the app before deploying, so a
failed build leaves the app existing and a re-run will conflict; recover with
`deno deploy --app <name>` instead of `create`.
