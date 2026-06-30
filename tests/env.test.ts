import { $ } from "dax";
import { assertEquals } from "@std/assert";

const TOKEN = Deno.env.get("DENO_DEPLOY_TOKEN");
const ORG = Deno.env.get("DENO_DEPLOY_TEST_ORG");
const APP = Deno.env.get("DENO_DEPLOY_TEST_APP");

// The mutating `env` commands persist real backend state, so these run only
// when a throwaway org/app is supplied via DENO_DEPLOY_TEST_ORG /
// DENO_DEPLOY_TEST_APP (alongside DENO_DEPLOY_TOKEN and DENO_DEPLOY_CLI_SPECIFIER).
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
    // Run from a throwaway cwd: resolving --org/--app persists a `deploy`
    // object to the working deno.json, which we discard with the temp dir.
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
      // add: stdout must be a single JSON object shaped like an `env list` item.
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
      // The id is derived from the mutation response, not a read-back.
      assertEquals(typeof parsed.id, "string");

      // update-value: result is derived from in-hand data with the new value;
      // a successful write must report the var object on stdout, never fail.
      res = await env(cwd, "update-value", key, "v2", ...target);
      assertEquals(res.code, 0, `update-value failed; stderr: ${res.stderr}`);
      assertEquals(res.stdout.trim().split("\n").length, 1);
      parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.key, key);
      assertEquals(parsed.value, "v2");

      // update-contexts (no contexts = "All"): result reflects contexts: null,
      // again derived from in-hand data with exit 0.
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

      // delete: result is an operation summary; the var is gone afterwards.
      res = await env(cwd, "delete", key, ...target);
      assertEquals(res.code, 0, `delete failed; stderr: ${res.stderr}`);
      parsed = JSON.parse(res.stdout.trim());
      assertEquals(parsed.key, key);
      assertEquals(parsed.deleted, true);
    } finally {
      // Best-effort cleanup in case an assertion aborted mid-cycle.
      await env(cwd, "delete", key, ...target).catch(() => {});
      await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
  },
});
