import { $ } from "dax";
import { assert, assertEquals } from "@std/assert";

const TOKEN = Deno.env.get("DENO_DEPLOY_TOKEN");
const ORG = Deno.env.get("DENO_DEPLOY_TEST_ORG");
const APP = Deno.env.get("DENO_DEPLOY_TEST_APP");

// Mutates real backend state; gated on a throwaway org/app being supplied.
const live = Boolean(TOKEN && ORG && APP);

async function env(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const escaped = args.map((a) => $.escapeArg(a)).join(" ");
  const result = await $.raw`deno deploy env ${escaped}`
    .cwd(cwd)
    .noThrow()
    .stdout("piped")
    .stderr("piped");
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

Deno.test({
  name:
    "env add/update-value/update-contexts/delete --json emit exactly one JSON object on stdout (exit 0)",
  ignore: !live,
  fn: async () => {
    // Temp cwd: resolving --org/--app writes a `deploy` block to deno.json.
    const cwd = await Deno.makeTempDir({ prefix: "deno-deploy-env-test-" });
    await Deno.writeTextFile(`${cwd}/deno.json`, "{}\n");
    const key = `AGENT_TEST_${
      crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()
    }`;
    const target = [
      "--org",
      ORG!,
      "--app",
      APP!,
      "--json",
      "--non-interactive",
    ];

    try {
      let res = await env(cwd, "add", key, "v1", ...target);
      assertEquals(res.code, 0, `add failed; stderr: ${res.stderr}`);
      assertEquals(
        res.stdout.trim().split("\n").length,
        1,
        `add stdout not a single line: ${JSON.stringify(res.stdout)}`,
      );
      let parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.key, key);
      assertEquals(parsed.value, "v1");
      assertEquals(parsed.isSecret, false);
      assertEquals(parsed.contexts, null);
      // id is best-effort per the CLI contract: string when the backend
      // returns created ids, otherwise null.
      assert(parsed.id === null || typeof parsed.id === "string");

      res = await env(cwd, "update-value", key, "v2", ...target);
      assertEquals(res.code, 0, `update-value failed; stderr: ${res.stderr}`);
      assertEquals(res.stdout.trim().split("\n").length, 1);
      parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.key, key);
      assertEquals(parsed.value, "v2");

      // No contexts = "All" -> contexts: null.
      res = await env(cwd, "update-contexts", key, ...target);
      assertEquals(
        res.code,
        0,
        `update-contexts failed; stderr: ${res.stderr}`,
      );
      assertEquals(res.stdout.trim().split("\n").length, 1);
      parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.key, key);
      assertEquals(parsed.contexts, null);

      res = await env(cwd, "delete", key, ...target);
      assertEquals(res.code, 0, `delete failed; stderr: ${res.stderr}`);
      parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.key, key);
      assertEquals(parsed.deleted, true);
    } finally {
      await env(cwd, "delete", key, ...target).catch(() => {});
      await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
  },
});
