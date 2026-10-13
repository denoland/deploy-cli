import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _internals, actionHandler } from "../config.ts";
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

Deno.test("deploy does not append a blank line on repeated updates", async () => {
  const input = `{
  "deploy": {
    "org": "old-org",
    "app": "my-app"
  }
}
`;
  const expected = `{
  "deploy": {
    "org": "my-org",
    "app": "my-app"
  }
}
`;

  const once = await runDeploy(input, { org: "my-org", app: "my-app" });
  const twice = await runDeploy(once, { org: "my-org", app: "my-app" });

  assertEquals(once, expected);
  assertEquals(twice, expected);
});

// Regression: a read-only command (one that never touches `config.files`) must
// NOT trigger the recursive deploy-manifest file walk. Before the lazy-`files`
// fix, `actionHandler` eagerly walked the whole working directory, so commands
// like `whoami`/`orgs list` hung for a very long time when invoked from a large
// directory tree. Rather than measure wall-clock time (flaky across machines),
// count invocations of the walk directly: it must run 0 times for a read-only
// action and exactly once when `.files` is read, while still yielding the real
// manifest on demand.
Deno.test("read-only action does not walk the file tree; .files stays lazy", async () => {
  const dir = await Deno.makeTempDir();
  const originalReadDeployFiles = _internals.readDeployFiles;
  let walkCount = 0;
  _internals.readDeployFiles = (...args) => {
    walkCount++;
    return originalReadDeployFiles(...args);
  };
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      `{ "deploy": { "org": "o", "app": "a" } }\n`,
    );
    const encoder = new TextEncoder();
    const sub = join(dir, "src");
    await Deno.mkdir(sub, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await Deno.writeFile(
        join(sub, `f${i}.ts`),
        encoder.encode("export const x = 1;\n"),
      );
    }

    const context = {
      config: undefined,
      ignore: [],
      allowNodeModules: false,
      debug: false,
    } as unknown as GlobalContext;

    // Read-only action: reads org/app, never touches `.files`.
    let seenOrg: string | undefined;
    await actionHandler((config) => {
      config.noCreate();
      config.noSave();
      seenOrg = config.org;
    }, () => dir)(context);

    assertEquals(seenOrg, "o");
    // The whole point of the fix: not touching `.files` must skip the walk.
    assertEquals(walkCount, 0, "read-only action must not walk the file tree");

    // Same action, but this one reads `.files`, forcing the recursive walk.
    let files: string[] = [];
    await actionHandler((config) => {
      config.noCreate();
      config.noSave();
      // Read twice to confirm the getter memoizes (a single walk).
      files = config.files;
      files = config.files;
    }, () => dir)(context);

    // The walk runs exactly once, and the manifest is available on demand.
    assertEquals(walkCount, 1, "reading .files must walk exactly once");
    assert(
      files.length >= 5,
      `expected the lazy manifest to include the tree files; got ${files.length}`,
    );
  } finally {
    _internals.readDeployFiles = originalReadDeployFiles;
    await Deno.remove(dir, { recursive: true });
  }
});
