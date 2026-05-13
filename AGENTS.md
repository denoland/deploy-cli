# AGENTS.md

This document is for **AI agents and CI systems** driving `deno deploy`
non-interactively. It complements the per-command `--help` output by documenting
the global conventions that hold across every subcommand.

If you are a human running this CLI from a terminal, you can ignore this file —
interactive mode is the default and behaves as it always has.

## Token authentication

The CLI reads a Deno Deploy access token from, in priority order:

1. The `--token <token>` flag.
2. The `DENO_DEPLOY_TOKEN` environment variable.
3. The OS keychain entry written by an earlier interactive `deno deploy`
   session.

When the token comes from `--token` or `DENO_DEPLOY_TOKEN`, the CLI **never**
opens a browser. An invalid or expired token surfaces as:

```json
{
  "error": {
    "code": "AUTH_INVALID_TOKEN",
    "message": "...",
    "hint": "Generate a new token at https://console.deno.com/account/tokens and re-export DENO_DEPLOY_TOKEN."
  }
}
```

with exit code `3`. Use `deno deploy whoami --json` to verify a token without
side effects (see Examples below).

## Global flags

Every subcommand of `deno deploy` and `deno deploy sandbox` honors:

| Flag                      | Effect                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`                  | Emit a single JSON object (or NDJSON for streaming commands) on **stdout**. Suppress ANSI color, spinners, and progress bars. Errors become a structured envelope on **stderr**. |
| `-y`, `--non-interactive` | Refuse to prompt. Any missing input that would normally prompt fails fast with a clear error naming the flag to pass instead.                                                    |
| `-q`, `--quiet`           | Suppress non-essential human-progress output. Final result still printed.                                                                                                        |
| `--debug`                 | Print stack traces and verbose diagnostics on stderr. Off by default.                                                                                                            |
| `--endpoint <url>`        | Override the API endpoint. Also reads `DENO_DEPLOY_ENDPOINT`.                                                                                                                    |
| `--token <token>`         | Override the token from env/keychain.                                                                                                                                            |
| `--config <path>`         | Path to a config file (defaults to `deno.json`/`deno.jsonc` in the working directory).                                                                                           |

`--non-interactive` and `--json` are independent: an agent can run with `--json`
alone and still get prompted on a TTY (rare), or `--non-interactive` alone and
still get human-readable text. The recommended agent invocation is
`--json --non-interactive` together.

## Exit codes

The CLI returns one of a small, stable set of exit codes. Agents should
pattern-match on the exit code first, then parse stderr if non-zero.

| Code | Name      | Meaning                                                                               |
| ---- | --------- | ------------------------------------------------------------------------------------- |
| `0`  | OK        | Success.                                                                              |
| `1`  | GENERIC   | Unclassified failure.                                                                 |
| `2`  | USAGE     | Bad flag, missing required value, or `--non-interactive` short-circuit.               |
| `3`  | AUTH      | Token missing, invalid, expired, or rejected by the backend.                          |
| `4`  | NOT_FOUND | The targeted org / app / database / revision / etc. doesn't exist or isn't reachable. |
| `5`  | CONFLICT  | A resource with the supplied name already exists.                                     |
| `6`  | NETWORK   | Backend 5xx, transport failure, or unreachable endpoint.                              |

`ValidationError` from Cliffy (typos in flag values) currently exits via
Cliffy's own handler with exit code `1` and a usage hint on stderr; this will
move to `2` in a follow-up.

## Structured error envelope

In `--json` mode, every error is written to **stderr** as a single line:

```json
{
  "error": {
    "code": "AUTH_INVALID_TOKEN",
    "message": "The token specified via 'DENO_DEPLOY_TOKEN' or the '--token' flag is invalid or expired.",
    "hint": "Generate a new token at https://console.deno.com/account/tokens and re-export DENO_DEPLOY_TOKEN.",
    "traceId": "abc123"
  }
}
```

Fields:

- `code` — Stable string identifier. Examples: `AUTH_INVALID_TOKEN`,
  `NON_INTERACTIVE_REQUIRED`, `MISSING_FLAG`, `SLUG_ALREADY_IN_USE`,
  `POSTGRES_ERROR`. New codes may be added; agents should treat unknown codes as
  opaque.
- `message` — Human-readable description.
- `hint` — Optional. If present, suggests a concrete next step.
- `traceId` — Optional. Server-side trace identifier from the `x-deno-trace-id`
  response header. Useful for bug reports.

Human-mode errors go to stderr too, formatted with ANSI markers, but without the
JSON envelope.

## JSON output schemas (per command)

These shapes are stable; new fields may be added but existing fields will not be
removed without a version bump.

### `deno deploy whoami --json`

```json
{
  "authenticated": true,
  "user": null,
  "orgs": [
    { "id": "...", "slug": "myorg", "name": "My Org", "plan": "pro" }
  ]
}
```

`user` is currently `null`; future backend support will populate it with
`{ id, name, email, ... }`. Agents reading `authenticated` / `orgs[]` will keep
working.

### `deno deploy orgs list --json`

```json
[
  { "id": "...", "slug": "myorg", "name": "My Org", "plan": "pro" }
]
```

### `deno deploy apps list --json`

```json
{
  "items": [
    {
      "id": "...",
      "slug": "my-app",
      "createdAt": "2026-05-12T14:40:00.000Z",
      "updatedAt": "2026-05-12T14:40:00.000Z",
      "layers": ["base"]
    }
  ],
  "nextCursor": null,
  "org": "myorg"
}
```

### `deno deploy deployments list --json`

```json
{
  "items": [
    {
      "id": "rev_...",
      "status": "routed",
      "prod": true,
      "createdAt": "...",
      "updatedAt": "...",
      "lastStep": "deployed"
    }
  ],
  "nextCursor": null,
  "org": "myorg",
  "app": "my-app"
}
```

### `deno deploy env list --json`

```json
[
  {
    "id": "...",
    "key": "DATABASE_URL",
    "value": "postgres://...",
    "isSecret": false,
    "contexts": ["production"]
  },
  {
    "id": "...",
    "key": "API_KEY",
    "value": null,
    "isSecret": true,
    "contexts": null
  }
]
```

`value` is `null` for secrets; `contexts: null` means "all contexts".

### `deno deploy database list --json`

```json
[
  {
    "name": "my-db",
    "engine": "postgresql",
    "createdAt": "...",
    "assignments": ["my-app"],
    "connection": {
      "hostname": "db.example.com",
      "port": 5432,
      "username": "deploy",
      "customCertificate": false
    },
    "databases": [{ "name": "main", "status": "ready", "createdAt": "..." }]
  }
]
```

### `deno deploy database query --json`

```json
{ "rows": [{ "column1": "value1", "column2": 42 }] }
```

On query failure the structured error envelope appears on stderr with
`errorCode: "POSTGRES_ERROR"` or `"QUERY_ERROR"`.

### `deno deploy publish --json`

```json
{
  "org": "myorg",
  "app": "my-app",
  "revisionId": "rev_...",
  "url": "https://console.deno.com/myorg/my-app/builds/rev_...",
  "status": "ready",
  "timelines": [
    { "partition": "production", "domains": ["https://my-app.deno.dev"] }
  ]
}
```

### `deno deploy create --json --dry-run`

```json
{
  "dryRun": true,
  "org": "myorg",
  "app": "my-app",
  "repo": null,
  "buildDirectory": ".",
  "buildConfig": {
    "frameworkPreset": "astro",
    "mode": "static",
    "staticDir": "dist",
    "singlePageApp": false
  },
  "buildTimeout": 5,
  "buildMemoryLimit": 1024,
  "region": "us"
}
```

### `deno deploy create --json` (non-dry-run, GitHub source)

```json
{
  "org": "myorg",
  "app": "my-app",
  "url": "https://console.deno.com/myorg/my-app",
  "revisionId": "rev_...",
  "source": "github"
}
```

For local source, the command delegates to `publish --json` and emits its
envelope instead.

### `deno deploy logs --json`

NDJSON, one record per line on stdout:

```json
{"timestamp":"2026-05-12T14:40:00.000Z","traceId":"...","spanId":"...","severity":"INFO","severityNumber":9,"body":"hello","scope":"app","revision":"rev_...","attributes":{...}}
```

## Non-interactive flag coverage

| Subcommand                     | Required flags under `--non-interactive`                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `deno deploy --prod`           | `--org`, `--app` (or pre-existing `deno.json` config)                                                                                     |
| `deno deploy create`           | `--org`, `--app`, `--source`, `--region`, plus per-source / per-mode flags                                                                |
| `deno deploy env list`         | `--org`, `--app`                                                                                                                          |
| `deno deploy env load`         | `--replace` or `--skip-existing` when existing keys overlap                                                                               |
| `deno deploy database *`       | `--org`, plus per-action flags                                                                                                            |
| `deno deploy setup-aws`        | `--org`, `--app`, `--policies <arn>` (repeatable), optional `--role-name`                                                                 |
| `deno deploy setup-gcp`        | `--org`, `--app`, `--roles <role>` (repeatable), optional `--service-account-name`, `--enable-apis` to bypass the API-enable confirmation |
| `deno deploy whoami`           | (none; reads token only)                                                                                                                  |
| `deno deploy apps list`        | `--org`                                                                                                                                   |
| `deno deploy orgs list`        | (none)                                                                                                                                    |
| `deno deploy deployments list` | `--org`, `--app`                                                                                                                          |

When a required flag is missing, the CLI exits `2` (USAGE) with a structured
envelope naming the missing flag.

## Stdio discipline

- **stdout** carries the result of the command. In `--json` mode this is a
  single object/array (or NDJSON for streaming). In human mode it is the
  formatted table / URL / etc.
- **stderr** carries human progress, prompts, and the structured error envelope.
  `--quiet` suppresses progress but keeps the final result on stdout.

This lets you pipe cleanly:

```sh
deno deploy publish --json | jq -r '.url'
deno deploy logs --json --app my-app | jq -c 'select(.severityNumber >= 17)'
deno deploy env list --json | jq '.[] | select(.isSecret == false)'
```

## Examples

### Verify auth

```sh
export DENO_DEPLOY_TOKEN=ddo_...
deno deploy whoami --json
# {"authenticated":true,"user":null,"orgs":[{"id":"...","slug":"myorg","name":"My Org","plan":"pro"}]}
```

### Create an app + deploy from local source

```sh
deno deploy create --json --non-interactive \
  --org myorg --app my-app \
  --source local --app-directory . \
  --runtime-mode static --static-dir dist \
  --region us
# (single JSON object: org, app, url, revisionId, status, timelines)
```

### Deploy to an existing app

```sh
deno deploy --json --non-interactive --org myorg --app my-app --prod .
```

### Load secrets from .env, idempotently

```sh
deno deploy env load --org myorg --app my-app --non-interactive --replace .env.production
```

### List failed deployments for an app

```sh
deno deploy deployments list --json --org myorg --app my-app --status failed | jq '.items[] | .id'
```

### Page through all apps

```sh
cursor=""
while :; do
  out=$(deno deploy apps list --json --org myorg ${cursor:+--cursor "$cursor"})
  echo "$out" | jq '.items[] | .slug'
  cursor=$(echo "$out" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done
```

### Cloud setup (AWS) without prompts

```sh
deno deploy setup-aws --json --non-interactive \
  --org myorg --app my-app \
  --policies arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --policies arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess \
  --role-name DenoDeploy-myorg-my-app
```

The `--role-name` makes the operation idempotent: re-running with the same name
will surface `SLUG_ALREADY_IN_USE` (`CONFLICT=5`) rather than silently creating
a second resource with a different random suffix.

## Compatibility & versioning

- New fields may be added to any JSON shape. Agents should ignore unknown
  fields.
- Exit-code values and `error.code` strings are stable; new values may be
  introduced.
- The flag set is stable; new flags may be added but the existing ones will not
  be renamed or repurposed.
