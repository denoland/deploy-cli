import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

// Token-free subprocess tests for the parse-time exit-code contract.

const MAIN_TS = fromFileUrl(new URL("../main.ts", import.meta.url));

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN_TS, ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("unknown flag exits with USAGE (2)", async () => {
  const res = await runCli(["--does-not-exist"]);
  assertEquals(res.code, 2, `stderr: ${res.stderr}`);
});

Deno.test("unknown flag with --json emits a USAGE envelope on stderr, clean stdout", async () => {
  const res = await runCli(["--json", "--does-not-exist"]);
  assertEquals(res.code, 2, `stderr: ${res.stderr}`);
  assertEquals(res.stdout.trim(), "", `stdout should be empty: ${res.stdout}`);
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "VALIDATION_ERROR");
  assert(
    typeof envelope.error.message === "string" &&
      envelope.error.message.length > 0,
    `expected a message; got: ${JSON.stringify(envelope)}`,
  );
});

Deno.test("combined short flag -jy is detected as JSON mode for the error envelope", async () => {
  const res = await runCli(["-jy", "--does-not-exist"]);
  assertEquals(res.code, 2, `stderr: ${res.stderr}`);
  assertEquals(res.stdout.trim(), "", `stdout should be empty: ${res.stdout}`);
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "VALIDATION_ERROR");
});

Deno.test("an unknown flag is not swallowed by the root's [root-path] argument", async () => {
  const res = await runCli(["--json", "--prd"]);
  assertEquals(res.code, 2, `stderr: ${res.stderr}`);
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assertEquals(envelope.error.code, "VALIDATION_ERROR");
  assert(
    envelope.error.message.includes("--prd"),
    `message should name the flag: ${envelope.error.message}`,
  );
});

Deno.test("flag-like positional values are still passed through", async () => {
  // `env add FOO -bar` must reach the action (which then requires auth) rather
  // than being rejected as an unknown option.
  const res = await runCli(
    ["env", "add", "FOO", "-bar", "--json", "--non-interactive"],
    { DENO_DEPLOY_TOKEN: "" }, // never reach the backend, whatever the runner has
  );
  const envelope = JSON.parse(res.stderr.trim().split("\n").pop()!);
  assert(
    envelope.error.code !== "VALIDATION_ERROR",
    `unexpected usage error: ${res.stderr}`,
  );
});

Deno.test("--help exits 0", async () => {
  const res = await runCli(["--help"]);
  assertEquals(res.code, 0, `stderr: ${res.stderr}`);
});

Deno.test("--version exits 0", async () => {
  const res = await runCli(["--version"]);
  assertEquals(res.code, 0, `stderr: ${res.stderr}`);
});

Deno.test("unknown flag exits with USAGE (2) on the standalone sandbox root", async () => {
  const res = await runCli(["--does-not-exist"], {
    DENO_DEPLOY_CLI_SANDBOX: "1",
  });
  assertEquals(res.code, 2, `stderr: ${res.stderr}`);
});
