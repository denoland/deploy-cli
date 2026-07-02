/**
 * Loads `@deno/sandbox` lazily, at command run time.
 *
 * The `deno deploy` subcommand executes this package with the user's
 * workspace config applied, so an eager import would make Deno consider a
 * workspace member named `@deno/sandbox` for the CLI's own module graph: a
 * member whose version satisfies the constraint gets linked in place of the
 * published package, and a non-matching one emits a "Workspace member ...
 * was not used" warning — for every command, even ones that never touch
 * sandboxes. Keeping the import dynamic confines both effects to the
 * `sandbox` subcommands. Type-only imports of `@deno/sandbox` are erased at
 * runtime and remain safe anywhere.
 */
export function sandboxApi(): Promise<typeof import("@deno/sandbox")> {
  return import("@deno/sandbox");
}
