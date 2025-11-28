# Development

Set `DENO_DEPLOY_CLI_SPECIFIER` env var to `main.ts` file url on your local machine.

```
export DENO_DEPLOY_CLI_SPECIFIER=file:///path/to/deploy-cli/main.ts
```

and run `deno deploy` commands, which uses your local copy of deploy-cli.
