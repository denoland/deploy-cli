# deploy-cli

The implementation of `deno deploy` subcommand.

## How this works

The source code of this repository is published to https://jsr.io/@deno/deploy

`deno deploy` subcommand executes the main entrypoint of `jsr:@deno/deploy`
[ref](https://github.com/denoland/deno/blob/efa4da8643c1ada18102bd3eeadb28171f7cdad6/cli/tools/deploy.rs#L47-L72).

## How to develop

Set the file url of main.ts of your local copy of this repository to
`DENO_DEPLOY_CLI_SPECIFIER` env var. e.g.
`DENO_DEPLOY_CLI_SPECIFIER=file:///path/to/deploy-cli/main.ts`, or run
`source dev_env.sh` at the root of this repo (This sets
`DENO_DEPLOY_CLI_SPECIFIER`)

Then `deno deploy` subcommand uses your local copy as its implementation.
