import { $ } from "dax";
import { assert, assertEquals } from "@std/assert";

if (!Deno.env.get("DENO_DEPLOY_TOKEN")) {
  console.error("DENO_DEPLOY_TOKEN environment variable is required.");
  Deno.exit(1);
}

const sandbox = async (...args: string[]) => {
  console.log(`deno sandbox ${args.join(" ")}`);
  return (await $.raw`deno sandbox ${args.join(" ")}`.text()).trim();
};

/**
 * `sandbox volumes create` returns the volume id immediately, but the
 * backend takes a moment to make the volume mountable inside a sandbox
 * even after it's queryable via `volumes list`. Poll the list endpoint
 * first, then sleep `postListSleepMs` to let the cluster sync — without
 * that extra sleep we still hit `VOLUME_NOT_FOUND` when the follow-up
 * `sandbox create --volume <id>:path` runs.
 */
async function waitForVolumeReady(
  volumeId: string,
  {
    timeoutMs = 30_000,
    intervalMs = 500,
    postListSleepMs = 5_000,
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await sandbox("volumes", "list");
    if (list.includes(volumeId)) {
      await new Promise((r) => setTimeout(r, postListSleepMs));
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for volume ${volumeId} to become visible via 'volumes list'`,
  );
}

Deno.test("sandbox create", async () => {
  const sandboxId = await sandbox(
    "create",
    "--quiet",
    "--timeout",
    "10s",
    "echo",
    "test",
  );
  await sandbox("kill", sandboxId);
});

Deno.test("sandbox create with arg separator", async () => {
  const sandboxId = await sandbox(
    "create",
    "--quiet",
    "--timeout",
    "10s",
    "--",
    "echo",
    "-n",
    "test",
  );
  await sandbox("kill", sandboxId);
});

Deno.test("sandbox exec", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--timeout", "30s");

  const res = await sandbox("exec", sandboxId, "echo", "'exec test'");
  assertEquals(res, "exec test");

  await sandbox("kill", sandboxId);
});

Deno.test("sandbox copy", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--timeout", "60s");

  await Deno.writeTextFile("test.txt", "test content");

  await sandbox("copy", "test.txt", `${sandboxId}:/tmp/test.txt`);

  await sandbox("copy", `${sandboxId}:/tmp/test.txt`, "./downloaded.txt");
  const downloadedContent = await Deno.readTextFile("./downloaded.txt");
  assertEquals(downloadedContent, "test content");

  await Deno.remove("test.txt");
  await Deno.remove("downloaded.txt");

  await sandbox("kill", sandboxId);
});

Deno.test("sandbox extend", async () => {
  const sandboxId = await sandbox(
    "create",
    "--quiet",
    "--timeout",
    "60s",
    "sleep",
    "10",
  );

  await sandbox("extend", sandboxId, "120s");

  await sandbox("kill", sandboxId);
});

Deno.test("sandbox exec with complex commands", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--timeout", "60s");

  const result = await sandbox("exec", sandboxId, "'echo hello && echo world'");
  assert(result.includes("hello"));
  assert(result.includes("world"));

  await sandbox("kill", sandboxId);
});

Deno.test("sandbox copy directory structure", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--timeout", "60s");

  await Deno.mkdir("testdir", { recursive: true });
  await Deno.writeTextFile("testdir/file1.txt", "content1");
  await Deno.writeTextFile("testdir/file2.txt", "content2");

  await sandbox("exec", sandboxId, "'mkdir -p /tmp/testdir'");
  await sandbox(
    "copy",
    "testdir/file1.txt",
    `${sandboxId}:/tmp/testdir/file1.txt`,
  );
  await sandbox(
    "copy",
    "testdir/file2.txt",
    `${sandboxId}:/tmp/testdir/file2.txt`,
  );

  const result = await sandbox("exec", sandboxId, "ls", "/tmp/testdir");
  assert(result.includes("file1.txt"));
  assert(result.includes("file2.txt"));

  await Deno.remove("testdir", { recursive: true });
  await sandbox("kill", sandboxId);
});

Deno.test("volumes create", async () => {
  const volumeName = `test-vol-${crypto.randomUUID()}`.slice(0, 32);

  const volumeId = await sandbox(
    "volumes",
    "create",
    volumeName,
    "--capacity",
    "1gb",
    "--region",
    "ord",
  );

  await sandbox("volumes", "delete", volumeId);
});

Deno.test("sandbox with volume mount", async () => {
  const volumeName = `test-vol-${crypto.randomUUID()}`.slice(0, 32);

  const volumeId = await sandbox(
    "volumes",
    "create",
    volumeName,
    "--capacity",
    "1gb",
    "--region",
    "ord",
  );
  await waitForVolumeReady(volumeId);

  // The sandbox-side volume lookup hits a different service from the
  // volumes list endpoint we just polled; that service propagates the
  // new volume asynchronously, so a one-shot wait isn't enough. Retry
  // the mount-bearing create a few times.
  let sandboxId: string | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      sandboxId = await sandbox(
        "create",
        "--quiet",
        "--timeout",
        "60s",
        "--volume",
        `${volumeId}:/data/dataset`,
      );
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!sandboxId) {
    throw new Error(
      `sandbox create with --volume kept failing: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  await sandbox(
    "exec",
    sandboxId,
    "\"echo 'volume test' > /data/dataset/test.txt\"",
  );
  const result = await sandbox(
    "exec",
    sandboxId,
    "cat",
    "/data/dataset/test.txt",
  );
  assertEquals(result, "volume test");

  await sandbox("kill", sandboxId);
  await sandbox("volumes", "delete", volumeId);
});
