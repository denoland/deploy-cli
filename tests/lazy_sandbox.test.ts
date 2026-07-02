import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";

// `deno deploy` runs this package with the user's workspace config applied,
// so an eager (static, non-type) import of @deno/sandbox would let a
// workspace member named @deno/sandbox be linked into the CLI's module graph
// (or emit a "workspace member was not used" warning) for every command.
// Assert that first-party code only reaches @deno/sandbox through dynamic
// imports; type-only imports are erased at runtime and are fine.

const MAIN_TS = fromFileUrl(new URL("../main.ts", import.meta.url));

interface InfoDependency {
  specifier: string;
  isDynamic?: boolean;
  code?: { specifier?: string };
}

interface InfoModule {
  specifier: string;
  dependencies?: InfoDependency[];
}

Deno.test("@deno/sandbox is not in the CLI's eager module graph", async () => {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", MAIN_TS],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(code === 0, new TextDecoder().decode(stderr));

  const graph = JSON.parse(new TextDecoder().decode(stdout)) as {
    modules: InfoModule[];
  };

  const offenders: string[] = [];
  for (const mod of graph.modules) {
    // Only first-party modules matter; edges inside the @deno/sandbox
    // package itself are unreachable unless the dynamic import runs.
    if (!mod.specifier.startsWith("file://")) continue;
    for (const dep of mod.dependencies ?? []) {
      const target = dep.code?.specifier ?? "";
      if (target.includes("@deno/sandbox") && !dep.isDynamic) {
        offenders.push(`${mod.specifier} -> ${target}`);
      }
    }
  }

  assert(
    offenders.length === 0,
    `static @deno/sandbox import(s) found (use sandbox/api.ts's lazy ` +
      `sandboxApi() or an \`import type\` instead):\n${offenders.join("\n")}`,
  );
});
