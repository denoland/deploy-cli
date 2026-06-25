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

`code` is the symbolic name of the exit code (see below); `hint` and `traceId`
may be absent.

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

- `env list` — list env vars
- `env add <variable> <value> [--secret]`
- `env update-value <variable> <value>`
- `env update-contexts <variable> [new-contexts...]`
- `env delete <variable>`
- `env load <file>`

### `database`

- `database provision <name> [--kind <kind>]`
- `database link <name> [connectionString] [--hostname --username --password --port --cert]`
- `database assign <name> [--app <name>]`
- `database detach <name> [--app <name>]`
- `database list [search]`
- `database query <name> <database> [query...]`
- `database delete <name>`

### Read-only listings (all support `--json`)

- `apps list [--org <name>] [--limit <n>] [--cursor <c>]`
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
  | jq -r '.url')
echo "deployed to $url"
```

**4. Set environment variables**

```sh
deno deploy env add API_KEY "$API_KEY" --secret --non-interactive --org my-org --app my-site
deno deploy env list --json --org my-org --app my-site
```

**5. List the most recent deployments as JSON**

```sh
deno deploy deployments list --json --org my-org --app my-site --limit 5
```

## Idempotency

Re-running `create`, `env add`, or `database provision` with the same inputs
either succeeds as a no-op or fails with the `CONFLICT` exit code (`5`) and an
"already exists" message — it never leaves partial state. Agents should treat
exit code `5` as "already done" rather than a hard failure.
