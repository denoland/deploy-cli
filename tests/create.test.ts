import { $ } from "dax";
import { assert, assertStringIncludes } from "@std/assert";

if (!Deno.env.get("DENO_DEPLOY_TOKEN")) {
  console.error("DENO_DEPLOY_TOKEN environment variable is required.");
  Deno.exit(1);
}

const deploy = async (...args: string[]) => {
  const escaped = args.map((a) => $.escapeArg(a)).join(" ");
  console.log(`deno deploy ${escaped}`);
  return (await $.raw`deno deploy ${escaped}`.text()).trim();
};

const deployFail = async (...args: string[]) => {
  const escaped = args.map((a) => $.escapeArg(a)).join(" ");
  console.log(`deno deploy ${escaped}`);
  const result = await $.raw`deno deploy ${escaped}`.noThrow()
    .stderr("piped").stdout("piped");
  const text = (result.stderr + result.stdout).trim();
  assert(result.code !== 0, `Expected non-zero exit code, got ${result.code}`);
  return text;
};

Deno.test("create with dynamic mode flags (dry-run)", async () => {
  const output = await deploy(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--runtime-mode",
    "dynamic",
    "--entrypoint",
    "main.ts",
    "--install-command",
    "deno install",
    "--build-command",
    "deno task build",
    "--pre-deploy-command",
    "echo done",
    "--build-timeout",
    "5",
    "--build-memory-limit",
    "1024",
    "--region",
    "us",
  );
  assertStringIncludes(output, "Using the following build configuration:");
});

Deno.test("create with static mode flags (dry-run)", async () => {
  const output = await deploy(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app-static",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--runtime-mode",
    "static",
    "--static-dir",
    "public",
    "--single-page-app",
    "--install-command",
    "deno install",
    "--build-command",
    "deno task build",
    "--pre-deploy-command",
    "echo done",
    "--build-timeout",
    "10",
    "--build-memory-limit",
    "2048",
    "--region",
    "eu",
  );
  assertStringIncludes(output, "Using the following build configuration:");
});

Deno.test("create with framework preset (dry-run)", async () => {
  const output = await deploy(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app-preset",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--framework-preset",
    "astro",
    "--build-timeout",
    "5",
    "--build-memory-limit",
    "1024",
    "--region",
    "us",
  );
  assertStringIncludes(output, "Using the following build configuration:");
});

Deno.test("create fails with invalid runtime-mode", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--runtime-mode",
    "invalid",
  );
  assertStringIncludes(output, "Invalid runtime mode");
});

Deno.test("create fails with invalid build-timeout", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--build-timeout",
    "99",
  );
  assertStringIncludes(output, "Invalid build timeout");
});

Deno.test("create fails with invalid build-memory-limit", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--build-memory-limit",
    "999",
  );
  assertStringIncludes(output, "Invalid build memory limit");
});

Deno.test("create fails with invalid region", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--region",
    "invalid",
  );
  assertStringIncludes(output, "Invalid region");
});

Deno.test("create fails with invalid framework-preset", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--framework-preset",
    "invalid",
  );
  assertStringIncludes(output, "Invalid runtime configuration");
});

Deno.test("create fails with invalid source", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "invalid",
  );
  assertStringIncludes(output, "Invalid source");
});

Deno.test("create fails when dynamic mode missing entrypoint", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--runtime-mode",
    "dynamic",
    "--install-command",
    "deno install",
    "--build-command",
    "deno task build",
    "--pre-deploy-command",
    "echo done",
    "--build-timeout",
    "5",
    "--build-memory-limit",
    "1024",
    "--region",
    "us",
  );
  assertStringIncludes(output, '"--entrypoint"');
});

Deno.test("create fails when static mode missing static-dir", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--runtime-mode",
    "static",
    "--install-command",
    "deno install",
    "--build-command",
    "deno task build",
    "--pre-deploy-command",
    "echo done",
    "--build-timeout",
    "5",
    "--build-memory-limit",
    "1024",
    "--region",
    "us",
  );
  assertStringIncludes(output, '"--static-dir"');
});

Deno.test("create fails when missing required --org", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--app",
    "test-app",
    "--source",
    "local",
  );
  assertStringIncludes(output, '"--org"');
});

Deno.test("create fails when missing required --app", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--source",
    "local",
  );
  assertStringIncludes(output, '"--app"');
});

Deno.test("create fails when missing required --source", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--region",
    "us",
  );
  assertStringIncludes(output, '"--source"');
});

Deno.test("create with dynamic mode and optional arguments (dry-run)", async () => {
  const output = await deploy(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app-args",
    "--source",
    "local",
    "--app-directory",
    ".",
    "--runtime-mode",
    "dynamic",
    "--entrypoint",
    "main.ts",
    "--arguments",
    "--port=8080",
    "--arguments",
    "--host=0.0.0.0",
    "--working-directory",
    "/app",
    "--install-command",
    "deno install",
    "--build-command",
    "deno task build",
    "--pre-deploy-command",
    "echo done",
    "--build-timeout",
    "5",
    "--build-memory-limit",
    "1024",
    "--region",
    "us",
  );
  assertStringIncludes(output, "Using the following build configuration:");
});

Deno.test("create fails when github source missing --owner", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "github",
  );
  assertStringIncludes(output, '"--owner"');
});

Deno.test("create fails when github source missing --repo", async () => {
  const output = await deployFail(
    "create",
    "--dry-run",
    "--org",
    "test",
    "--app",
    "test-app",
    "--source",
    "github",
    "--owner",
    "denoland",
  );
  assertStringIncludes(output, '"--repo"');
});
