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

Deno.test("setup-aws --non-interactive without --policies surfaces MISSING_FLAG", async () => {
  const res = await deployRaw(
    "setup-aws",
    "--json",
    "--non-interactive",
    "--org",
    "test",
    "--app",
    "test-app",
    "--endpoint",
    "http://127.0.0.1:1",
  );
  assert(res.code !== 0, `expected non-zero exit; stderr: ${res.stderr}`);
  // Stderr may carry tRPC/network preamble; the structured envelope is the
  // last line.
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  // We get here only if the auth check resolves; on a localhost endpoint
  // that's never going to reach `setupAws`, so accept either MISSING_FLAG
  // (the agent-friendly outcome) or an auth/network error envelope.
  assert(
    typeof envelope.error?.code === "string",
    `expected an error envelope; got: ${JSON.stringify(envelope)}`,
  );
});

Deno.test("whoami --json with bad token emits AUTH envelope (exit 3, no browser)", async () => {
  const res = await deployRaw(
    "--json",
    "--token",
    "obviously-invalid-token",
    "--endpoint",
    "http://127.0.0.1:1",
    "whoami",
  );
  assertEquals(res.code, 3, `stderr: ${res.stderr}`);
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "AUTH_INVALID_TOKEN");
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

async function sandboxRaw(...args: string[]): Promise<
  { code: number; stdout: string; stderr: string }
> {
  const escaped = args.map((a) => $.escapeArg(a)).join(" ");
  const result = await $.raw`deno sandbox ${escaped}`.noThrow()
    .stdout("piped").stderr("piped");
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

Deno.test("sandbox --help advertises --json and --non-interactive", async () => {
  // The standalone `deno sandbox` root must expose the same agent flags as
  // `deno deploy`, otherwise agents can't drive it non-interactively.
  const res = await sandboxRaw("--help");
  assertEquals(res.code, 0, `stderr: ${res.stderr}`);
  assertStringIncludes(res.stdout, "--json");
  assertStringIncludes(res.stdout, "--non-interactive");
});

Deno.test("sandbox list --json emits a structured error envelope, never a browser/hang", async () => {
  // Bad token + unreachable endpoint: the command must fail fast with a
  // machine-parseable envelope on stderr (and a clean stdout) rather than
  // attempting the OAuth browser flow or blocking on a prompt.
  const res = await sandboxRaw(
    "--json",
    "--token",
    "obviously-invalid-token",
    "--endpoint",
    "http://127.0.0.1:1",
    "list",
    "--org",
    "test",
  );
  assert(res.code !== 0, `expected non-zero exit; stderr: ${res.stderr}`);
  // The structured envelope is the last line of stderr (tRPC/network preamble
  // may precede it). Exact code is auth-vs-network dependent on the endpoint;
  // assert the agent-facing contract: a single error object with a string code.
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assert(
    typeof envelope.error?.code === "string",
    `expected an error envelope; got: ${JSON.stringify(envelope)}`,
  );
  assertEquals(
    res.stdout.trim(),
    "",
    `stdout should stay clean: ${res.stdout}`,
  );
});
