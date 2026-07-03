import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { actionHandler } from "../config.ts";
import type { GlobalContext } from "../main.ts";

// Runs the deploy action handler on a temporary config
async function runDeploy(
  content: string,
  resolved: { org: string | undefined; app: string | undefined },
): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "deno.json");
  try {
    await Deno.writeTextFile(path, content);
    const context = {
      config: path,
      ignore: [],
      allowNodeModules: false,
      debug: false,
    } as unknown as GlobalContext;

    await actionHandler((config) => {
      config.org = resolved.org;
      config.app = resolved.app;
    })(context);

    return await Deno.readTextFile(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("deploy preserves other deploy fields when persisting org/app", async () => {
  const input = `{
  "deploy": {
    "org": "old-org",
    "app": "old-app",
    "exclude": ["!dist"],
    "framework": "fresh"
  }
}
`;
  const outputConfigJson = await runDeploy(input, {
    org: "my-org",
    app: "my-app",
  });
  const outputConfig = JSON.parse(outputConfigJson);

  assertEquals(outputConfig.deploy.org, "my-org");
  assertEquals(outputConfig.deploy.app, "my-app");
  assertEquals(outputConfig.deploy.exclude, ["!dist"]);
  assertEquals(outputConfig.deploy.framework, "fresh");
});

Deno.test("deploy creates the deploy block when the config has none", async () => {
  const outputConfigJson = await runDeploy("{}\n", {
    org: "my-org",
    app: "my-app",
  });
  const outputConfig = JSON.parse(outputConfigJson);

  assertEquals(outputConfig.deploy.org, "my-org");
  assertEquals(outputConfig.deploy.app, "my-app");
});

Deno.test("deploy clears app when it doesn't resolve but keeps siblings", async () => {
  const input = `{
  "deploy": { "org": "old-org", "app": "stale", "exclude": ["!dist"] }
}
`;

  const outputConfigJson = await runDeploy(input, {
    org: "my-org",
    app: undefined,
  });
  const out = JSON.parse(outputConfigJson);

  assertEquals(out.deploy.app, undefined);
  assertEquals(out.deploy.exclude, ["!dist"]);
});

Deno.test("deploy preserves comments and formatting (jsonc)", async () => {
  const input = `{
  // keep this comment
  "deploy": {
    "org": "old-org", // and this one
    "exclude": ["!dist"]
  }
}
`;

  const out = await runDeploy(input, { org: "my-org", app: undefined });

  assertStringIncludes(out, "// keep this comment");
  assertStringIncludes(out, "// and this one");
});

// Regression: a read-only command (one that never touches `config.files`) must
// NOT trigger the recursive deploy-manifest file walk. Before the lazy-`files`
// fix, `actionHandler` eagerly walked the whole working directory, so commands
// like `whoami`/`orgs list` hung for a very long time when invoked from a large
// directory tree. This builds a large tree and asserts the action returns fast
// when it doesn't read `.files`, then that `.files` still yields the manifest
// on demand.
Deno.test("read-only action does not walk the file tree; .files stays lazy", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      `{ "deploy": { "org": "o", "app": "a" } }\n`,
    );
    // A wide/deep tree that is expensive to walk. If the walk were eager this
    // test would be dramatically slower (and previously effectively hung on
    // real home directories with hundreds of thousands of files).
    const encoder = new TextEncoder();
    for (let a = 0; a < 30; a++) {
      for (let b = 0; b < 30; b++) {
        const sub = join(dir, `d${a}`, `s${b}`);
        await Deno.mkdir(sub, { recursive: true });
        for (let c = 0; c < 10; c++) {
          await Deno.writeFile(
            join(sub, `f${c}.ts`),
            encoder.encode("export const x = 1;\n"),
          );
        }
      }
    }

    const context = {
      config: undefined,
      ignore: [],
      allowNodeModules: false,
      debug: false,
    } as unknown as GlobalContext;

    // Read-only action: reads org/app, never touches `.files`.
    let seenOrg: string | undefined;
    const readOnlyStart = performance.now();
    await actionHandler((config) => {
      config.noCreate();
      config.noSave();
      seenOrg = config.org;
    }, () => dir)(context);
    const readOnlyMs = performance.now() - readOnlyStart;

    assertEquals(seenOrg, "o");

    // Same action, but this one reads `.files`, forcing the recursive walk.
    let files: string[] = [];
    const withFilesStart = performance.now();
    await actionHandler((config) => {
      config.noCreate();
      config.noSave();
      files = config.files;
    }, () => dir)(context);
    const withFilesMs = performance.now() - withFilesStart;

    // The manifest is still available on demand for the upload path.
    assert(
      files.length >= 9000,
      `expected the lazy manifest to include the tree files; got ${files.length}`,
    );

    // The whole point of the fix: NOT touching `.files` must skip the walk, so
    // the read-only action is dramatically cheaper than the walking one. Before
    // the fix both walked eagerly and cost about the same (the read-only path
    // then hung outright on very large trees). Require a clear margin rather
    // than an absolute time bound so the test stays robust across machines.
    assert(
      readOnlyMs * 3 < withFilesMs,
      `read-only action (${
        readOnlyMs.toFixed(1)
      }ms) was not markedly cheaper ` +
        `than the manifest-walking action (${withFilesMs.toFixed(1)}ms); the ` +
        `file walk was likely not skipped`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
