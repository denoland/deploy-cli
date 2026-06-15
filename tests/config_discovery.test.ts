// Regression coverage for the config-discovery split: deploy-config metadata
// lookup (org/app) must be decoupled from source-file collection so that
// non-publish commands (sandbox, logs, env, ...) never walk the filesystem
// below cwd. The filesystem-walk regression is what makes commands appear to
// hang when run from `/` inside a container (walking /sys, /proc, ...).
//
// These tests are intentionally NON-LIVE: they do not need a real
// DENO_DEPLOY_TOKEN and never reach the network. The CLI cases fail fast at the
// non-interactive auth gate (stdin is not a TTY and the token is neutralized),
// which happens AFTER config discovery — so any stray downward walk still shows
// up in `--debug` output before the process exits.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, relative } from "@std/path";
import {
  collectDeploySourceFiles,
  readDeployConfigMetadata,
} from "../config.ts";

/** Assert `haystack` does not contain `needle`, with a diagnostic message. */
function assertNotIncludes(haystack: string, needle: string, msg?: string) {
  assert(
    !haystack.includes(needle),
    msg ?? `expected output not to include ${JSON.stringify(needle)}`,
  );
}

const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));

/**
 * Run the CLI from `cwd` with ambient Deploy credentials/endpoint neutralized
 * and stdin detached, so it fails fast and offline at the auth/non-interactive
 * gate. Returns the exit code and combined stdout+stderr (which includes
 * `--debug` file-walk diagnostics, if any).
 */
async function runCli(
  cwd: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...args],
    cwd,
    env: {
      DENO_DEPLOY_TOKEN: "",
      DENO_DEPLOY_ENDPOINT: "",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return { code, output: decoder.decode(stdout) + decoder.decode(stderr) };
}

Deno.test("sandbox create does not walk cwd source files before auth", async () => {
  const root = await Deno.makeTempDir();
  try {
    // A root-like trap subtree (mimics /sys/class/tty/...). It must never be
    // traversed for `sandbox create`.
    await Deno.mkdir(`${root}/sys/class/tty/trap`, { recursive: true });
    await Deno.writeTextFile(`${root}/sys/class/tty/trap/sentinel.txt`, "trap");

    const { code, output } = await runCli(root, [
      "sandbox",
      "create",
      "--org",
      "test-org",
      "--timeout",
      "5m",
      "--debug",
    ]);

    assert(code !== 0, `expected a non-zero exit code, got ${code}`);
    assertNotIncludes(output, "sys/class/tty/trap");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deploy management command (logs) does not walk cwd source files", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/deno.jsonc`,
      `{\n  "deploy": { "org": "example-org", "app": "example-app" }\n}\n`,
    );
    await Deno.mkdir(`${root}/trap`, { recursive: true });
    await Deno.writeTextFile(`${root}/trap/sentinel.txt`, "trap");

    const { code, output } = await runCli(root, ["logs", "--debug"]);

    assert(code !== 0, `expected a non-zero exit code, got ${code}`);
    assertNotIncludes(output, "trap/sentinel.txt");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readDeployConfigMetadata reads org/app without collecting files", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/deno.jsonc`,
      `{\n  "deploy": { "org": "example-org", "app": "example-app" }\n}\n`,
    );
    // A trap subtree that downward collection would walk but metadata lookup
    // must not.
    await Deno.mkdir(`${root}/trap`, { recursive: true });
    await Deno.writeTextFile(`${root}/trap/sentinel.txt`, "trap");

    const metadata = await readDeployConfigMetadata(root, undefined, false);

    assertEquals(metadata.org, "example-org");
    assertEquals(metadata.app, "example-app");
    // The metadata path must not surface a source-file list at all.
    assertEquals((metadata as { files?: unknown }).files, undefined);
    assert(metadata.config !== undefined, "expected a config file to be found");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("collectDeploySourceFiles collects publish files and respects deploy.exclude + node_modules", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/deno.jsonc`,
      `{\n  "deploy": {\n    "org": "example-org",\n    "app": "example-app",\n    "exclude": ["ignored.tmp"]\n  }\n}\n`,
    );
    await Deno.writeTextFile(`${root}/main.ts`, "console.log('hi');");
    await Deno.mkdir(`${root}/static`, { recursive: true });
    await Deno.writeTextFile(`${root}/static/index.html`, "<h1>hi</h1>");
    await Deno.mkdir(`${root}/node_modules`, { recursive: true });
    await Deno.writeTextFile(`${root}/node_modules/ignored.js`, "ignored");
    await Deno.writeTextFile(`${root}/ignored.tmp`, "ignored");

    const result = await collectDeploySourceFiles(
      root,
      undefined,
      [],
      false,
      false,
    );

    const rel = result.files.map((p) =>
      relative(root, p).replaceAll("\\", "/")
    );

    assert(
      rel.includes("main.ts"),
      `main.ts missing from ${JSON.stringify(rel)}`,
    );
    assert(
      rel.includes("static/index.html"),
      `static/index.html missing from ${JSON.stringify(rel)}`,
    );
    assert(
      !rel.includes("node_modules/ignored.js"),
      "node_modules must be ignored by default",
    );
    assert(
      !rel.includes("ignored.tmp"),
      "deploy.exclude must drop ignored.tmp",
    );
    assertEquals(result.org, "example-org");
    assertEquals(result.app, "example-app");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("collectDeploySourceFiles honors explicit ignore paths", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${root}/deno.jsonc`,
      `{\n  "deploy": { "org": "example-org", "app": "example-app" }\n}\n`,
    );
    await Deno.writeTextFile(`${root}/main.ts`, "console.log('hi');");
    await Deno.writeTextFile(`${root}/secret.txt`, "secret");

    const result = await collectDeploySourceFiles(
      root,
      undefined,
      ["secret.txt"],
      false,
      false,
    );

    const rel = result.files.map((p) =>
      relative(root, p).replaceAll("\\", "/")
    );
    assert(
      rel.includes("main.ts"),
      `main.ts missing from ${JSON.stringify(rel)}`,
    );
    assert(
      !rel.includes("secret.txt"),
      "explicit ignore path must drop secret.txt",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("collectDeploySourceFiles includes node_modules when explicitly allowed", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/main.ts`, "console.log('hi');");
    await Deno.mkdir(`${root}/node_modules`, { recursive: true });
    await Deno.writeTextFile(`${root}/node_modules/dep.js`, "dep");

    const result = await collectDeploySourceFiles(
      root,
      undefined,
      [],
      true,
      false,
    );

    const rel = result.files.map((p) =>
      relative(root, p).replaceAll("\\", "/")
    );
    assert(
      rel.includes("node_modules/dep.js"),
      `node_modules should be included when allowed: ${JSON.stringify(rel)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
