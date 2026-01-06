import { $ } from "jsr:@david/dax";
import { assertEquals, assertExists } from "jsr:@std/assert";

if (!Deno.env.get("DENO_DEPLOY_TOKEN")) {
  console.error("DENO_DEPLOY_TOKEN environment variable is required.");
  Deno.exit(1);
}

const sandbox = async (...args: string[]) => {
  console.log(`deno sandbox ${args.join(" ")}`);
  return await $.raw`deno sandbox ${args.join(" ")}`.text();
};

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
  assertExists(volumeId.trim());

  await sandbox("volumes", "delete", volumeId.trim());
});

Deno.test("sandbox create", async () => {
  const sandboxId = await sandbox(
    "create",
    "--quiet",
    "--lifetime",
    "60s",
    "echo",
    "test",
  );
  await sandbox("kill", sandboxId.trim());
});

Deno.test("sandbox exec", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--lifetime", "60s");
  const cleanId = sandboxId.trim();
  console.log(cleanId);

  const res = await sandbox("exec", cleanId, "echo", "'exec test'");
  assertEquals(res.trim(), "exec test");

  await sandbox("kill", cleanId);
});

Deno.test("sandbox copy", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--lifetime", "60s");
  const cleanId = sandboxId.trim();

  await Deno.writeTextFile("test.txt", "test content");

  await sandbox("copy", "test.txt", `${cleanId}:/tmp/test.txt`);

  await sandbox("copy", `${cleanId}:/tmp/test.txt`, "./downloaded.txt");
  const downloadedContent = await Deno.readTextFile("./downloaded.txt");
  assertEquals(downloadedContent, "test content");

  await Deno.remove("test.txt");
  await Deno.remove("downloaded.txt");

  await sandbox("kill", cleanId);
});

Deno.test("sandbox extend", async () => {
  const sandboxId = await sandbox(
    "create",
    "--quiet",
    "--lifetime",
    "60s",
    "sleep",
    "10",
  );
  const cleanId = sandboxId.trim();

  await sandbox("extend", cleanId, "120s");

  await sandbox("kill", cleanId);
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
  const cleanVolumeId = volumeId.trim();

  const sandboxId = await sandbox(
    "create",
    "--quiet",
    "--lifetime",
    "60s",
    "--volume",
    `${cleanVolumeId}:/data/dataset`,
  );
  const cleanId = sandboxId.trim();

  await sandbox(
    "exec",
    cleanId,
    "\"echo 'volume test' > /data/dataset/test.txt\"",
  );
  const result = await sandbox(
    "exec",
    cleanId,
    "cat",
    "/data/dataset/test.txt",
  );
  assertEquals(result.trim(), "volume test");

  await sandbox("kill", cleanId);
  await sandbox("volumes", "delete", cleanVolumeId);
});

Deno.test("sandbox exec with complex commands", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--lifetime", "60s");
  const cleanId = sandboxId.trim();

  const result = await sandbox("exec", cleanId, "'echo hello && echo world'");
  assertEquals(result.includes("hello"), true);
  assertEquals(result.includes("world"), true);

  await sandbox("kill", cleanId);
});

Deno.test("sandbox copy directory structure", async () => {
  const sandboxId = await sandbox("create", "--quiet", "--lifetime", "60s");
  const cleanId = sandboxId.trim();

  await Deno.mkdir("testdir", { recursive: true });
  await Deno.writeTextFile("testdir/file1.txt", "content1");
  await Deno.writeTextFile("testdir/file2.txt", "content2");

  await sandbox("exec", cleanId, "'mkdir -p /tmp/testdir'");
  await sandbox(
    "copy",
    "testdir/file1.txt",
    `${cleanId}:/tmp/testdir/file1.txt`,
  );
  await sandbox(
    "copy",
    "testdir/file2.txt",
    `${cleanId}:/tmp/testdir/file2.txt`,
  );

  const result = await sandbox("exec", cleanId, "ls", "/tmp/testdir");
  assertEquals(result.includes("file1.txt"), true);
  assertEquals(result.includes("file2.txt"), true);

  await Deno.remove("testdir", { recursive: true });
  await sandbox("kill", cleanId);
});
