import { assertEquals, assertStringIncludes } from "@std/assert";
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
