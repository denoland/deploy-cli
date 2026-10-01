import { assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  collectDenoJsonFiles,
  normalizeBuildDirectory,
} from "../deploy/publish.ts";

Deno.test("normalizeBuildDirectory: matches the console's normalization", () => {
  assertEquals(normalizeBuildDirectory(""), "");
  assertEquals(normalizeBuildDirectory("."), "");
  assertEquals(normalizeBuildDirectory("apps/web"), "apps/web");
  assertEquals(normalizeBuildDirectory("./apps/web/"), "apps/web");
  assertEquals(normalizeBuildDirectory("apps\\web"), "apps/web");
  assertEquals(normalizeBuildDirectory("..app"), "..app");
  assertEquals(normalizeBuildDirectory("../private"), "");
  assertEquals(normalizeBuildDirectory("apps/../.."), "");
  assertEquals(normalizeBuildDirectory("..\\private"), "");
});

async function withProject(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  try {
    for (const [path, content] of Object.entries(files)) {
      await Deno.mkdir(join(root, dirname(path)), { recursive: true });
      await Deno.writeTextFile(join(root, path), content);
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("collectDenoJsonFiles: sends only the app directory's config", async () => {
  await withProject({
    "deno.json": "root",
    "apps/web/deno.json": "web",
    "apps/api/deno.json": "api",
  }, async (rootPath) => {
    const uploaded = {
      "deno.json": "root",
      "apps/web/deno.json": "web",
      "apps/api/deno.json": "api",
    };
    assertEquals(
      await collectDenoJsonFiles({
        rootPath,
        buildDirectory: "apps/web",
        uploaded,
      }),
      { "apps/web/deno.json": "web" },
    );
    assertEquals(
      await collectDenoJsonFiles({
        rootPath,
        buildDirectory: "./apps/web/",
        uploaded,
      }),
      { "apps/web/deno.json": "web" },
    );
    assertEquals(
      await collectDenoJsonFiles({ rootPath, buildDirectory: "", uploaded }),
      { "deno.json": "root" },
    );
  });
});

Deno.test("collectDenoJsonFiles: reads a config the upload excluded", async () => {
  await withProject({
    "apps/web/deno.jsonc": "web",
  }, async (rootPath) => {
    assertEquals(
      await collectDenoJsonFiles({
        rootPath,
        buildDirectory: "apps/web",
        uploaded: {},
      }),
      { "apps/web/deno.jsonc": "web" },
    );
  });
});

Deno.test("collectDenoJsonFiles: --config stands in for the app directory's", async () => {
  await withProject({
    "staging.json": "staging",
  }, async (rootPath) => {
    assertEquals(
      await collectDenoJsonFiles({
        rootPath,
        buildDirectory: "apps/web",
        uploaded: { "apps/web/deno.jsonc": "web" },
        configPath: join(rootPath, "staging.json"),
      }),
      { "apps/web/deno.json": "staging" },
    );
  });
});

Deno.test("collectDenoJsonFiles: never reads outside the deploy root", async () => {
  await withProject({
    "project/main.ts": "",
    "private/deno.json": "secret",
  }, async (dir) => {
    const rootPath = join(dir, "project");
    for (const buildDirectory of ["../private", "..\\private"]) {
      assertEquals(
        await collectDenoJsonFiles({ rootPath, buildDirectory, uploaded: {} }),
        {},
        buildDirectory,
      );
    }
  });
});

Deno.test("collectDenoJsonFiles: never follows a symlink out of the deploy root", async () => {
  await withProject({
    "project/main.ts": "",
    "private/deno.json": "secret",
  }, async (dir) => {
    const rootPath = join(dir, "project");
    await Deno.symlink(join(dir, "private"), join(rootPath, "linked"));
    await Deno.symlink(
      join(dir, "private", "deno.json"),
      join(rootPath, "deno.json"),
    );
    assertEquals(
      await collectDenoJsonFiles({
        rootPath,
        buildDirectory: "linked",
        uploaded: {},
      }),
      {},
    );
    assertEquals(
      await collectDenoJsonFiles({
        rootPath,
        buildDirectory: "",
        uploaded: {},
      }),
      {},
    );
  });
});
