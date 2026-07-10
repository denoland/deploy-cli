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

// --- `--help-json`: machine-readable command tree (agent discoverability) ---

interface HelpNode {
  name: string;
  path: string;
  description: string;
  hidden: boolean;
  arguments: Array<{ name: string; type: string }>;
  options: Array<
    {
      name: string;
      flags: string[];
      description: string;
      global: boolean;
      required: boolean;
    }
  >;
  commands: HelpNode[];
}

async function helpJson(args: string[] = []): Promise<HelpNode> {
  const res = await runCli([...args, "--help-json"]);
  assertEquals(res.code, 0, `stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function walk(node: HelpNode): HelpNode[] {
  return [node, ...node.commands.flatMap(walk)];
}

Deno.test("--help-json dumps the command tree as a single JSON object", async () => {
  const root = await helpJson();
  assertEquals(root.name, "deno deploy");
  const names = root.commands.map((cmd) => cmd.name);
  for (const expected of ["create", "env", "apps", "whoami", "sandbox"]) {
    assert(names.includes(expected), `missing ${expected} in ${names}`);
  }
});

Deno.test("--help-json advertises the global agent flags", async () => {
  const root = await helpJson();
  for (const flag of ["--json", "--non-interactive"]) {
    const option = root.options.find((opt) => opt.flags.includes(flag));
    assert(option, `missing global option ${flag}`);
    assertEquals(option.global, true, `${flag} should be global`);
  }
  // Inherited globals must also be visible on a leaf, so an agent reading a
  // single node sees every flag that node accepts.
  const list = await helpJson(["env", "list"]);
  assert(list.options.some((opt) => opt.flags.includes("--json")));
});

Deno.test("--help-json: every command and option has a description", async () => {
  const root = await helpJson();
  for (const cmd of walk(root)) {
    assert(cmd.description.length > 0, `${cmd.path} has no description`);
    for (const opt of cmd.options) {
      assert(
        opt.description.length > 0,
        `${cmd.path} ${opt.flags.join(",")} has no description`,
      );
    }
  }
});

Deno.test("--help-json resolves the addressed subcommand", async () => {
  const list = await helpJson(["env", "list"]);
  assertEquals(list.name, "list");
  assertEquals(list.path, "deno deploy env list");
});

Deno.test("--help-json ignores required options of the addressed command", async () => {
  // `setup-aws --org` is required; introspection must not trip its validation.
  const setupAws = await helpJson(["setup-aws"]);
  assertEquals(setupAws.name, "setup-aws");
  const org = setupAws.options.find((opt) => opt.flags.includes("--org"));
  assert(org, "missing --org");
  assertEquals(org.required, true);
});

Deno.test("--help-json works on the standalone sandbox root", async () => {
  const res = await runCli(["--help-json"], { DENO_DEPLOY_CLI_SANDBOX: "1" });
  assertEquals(res.code, 0, `stderr: ${res.stderr}`);
  const root: HelpNode = JSON.parse(res.stdout);
  assert(root.options.some((opt) => opt.flags.includes("--json")));
});
