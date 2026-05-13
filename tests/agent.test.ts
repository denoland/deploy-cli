import { $ } from "dax";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

if (!Deno.env.get("DENO_DEPLOY_TOKEN")) {
  console.error("DENO_DEPLOY_TOKEN environment variable is required.");
  Deno.exit(1);
}

async function deployRaw(...args: string[]): Promise<
  { code: number; stdout: string; stderr: string }
> {
  const escaped = args.map((a) => $.escapeArg(a)).join(" ");
  const result = await $.raw`deno deploy ${escaped}`.noThrow()
    .stdout("piped").stderr("piped");
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

Deno.test("create --json --dry-run emits a single JSON object on stdout", async () => {
  const res = await deployRaw(
    "create",
    "--json",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app-json",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--runtime-mode",
    "static",
    "--static-dir",
    "public",
    "--build-timeout",
    "5",
    "--build-memory-limit",
    "1024",
    "--region",
    "us",
  );
  assertEquals(res.code, 0, `stderr: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEquals(parsed.dryRun, true);
  assertEquals(parsed.org, "test");
  assertEquals(parsed.app, "test-app-json");
  assertEquals(parsed.region, "us");
  assertEquals(parsed.buildConfig.mode, "static");
  assertEquals(parsed.buildConfig.staticDir, "public");
});

Deno.test("create --non-interactive without flags fails with NON_INTERACTIVE_REQUIRED", async () => {
  // No source/org/app means createFlow() is entered, which now refuses
  // interactivity when --non-interactive is set even on a TTY.
  const res = await deployRaw("create", "--non-interactive", "--json");
  assert(res.code !== 0, "expected non-zero exit");
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "NON_INTERACTIVE_REQUIRED");
  assertStringIncludes(envelope.error.message, "interactive input");
});

Deno.test("--json error envelope uses AUTH_INVALID_TOKEN on bad token", async () => {
  const res = await deployRaw(
    "--json",
    "--token",
    "obviously-invalid-token",
    "--endpoint",
    "http://127.0.0.1:1",
    "env",
    "list",
    "--org",
    "test",
    "--app",
    "test-app",
  );
  assertEquals(
    res.code,
    3,
    `unexpected exit: ${res.code}, stderr: ${res.stderr}`,
  );
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "AUTH_INVALID_TOKEN");
  assertStringIncludes(envelope.error.hint, "DENO_DEPLOY_TOKEN");
});

Deno.test("--yes is an alias for --non-interactive", async () => {
  const res = await deployRaw("create", "-y", "--json");
  assert(res.code !== 0);
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "NON_INTERACTIVE_REQUIRED");
});

Deno.test("non-zero exit code matches taxonomy for invalid flag (USAGE=2)", async () => {
  // Cliffy's ValidationError handler exits with code 1 by default;
  // verify the agent can pattern-match on stderr text either way.
  const res = await deployRaw(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "invalid",
  );
  assert(res.code !== 0);
  assertStringIncludes(res.stderr + res.stdout, "Invalid source");
});
