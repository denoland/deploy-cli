import { TarStream, type TarStreamDir, type TarStreamFile } from "@std/tar";
import { compile as gitignoreCompile } from "@cfa/gitignore-parser";
import { walk, type WalkEntry } from "@std/fs";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { Spinner } from "@std/cli/unstable-spinner";
import { join, relative, resolve } from "@std/path";
import { green, yellow } from "@std/fmt/colors";
import { type Config, writeConfig } from "./config.ts";
import { authedFetch, createTrpcClient } from "./auth.ts";
import { error } from "./util.ts";

const SEPARATOR_PATTERN = Deno.build.os === "windows" ? "\\\\" : "/";

type Chunk =
  & { chunk: WalkEntry; relativePath: string }
  & ({ hash?: undefined; data?: undefined } | {
    hash: string;
    data: Uint8Array;
  });

export async function publish(
  debug: boolean,
  deployUrl: string,
  rootPath: string,
  configContent: Config | null,
  org: string,
  app: string,
  prod: boolean,
) {
  let gitignore: { denies(input: string): boolean } = {
    denies: () => false,
  };

  try {
    gitignore = gitignoreCompile(
      Deno.readTextFileSync(join(rootPath, ".gitignore")),
    );
  } catch (_) {
    //
  }

  const excludes = [
    new RegExp(`${SEPARATOR_PATTERN}node_modules(:?${SEPARATOR_PATTERN}|$)`),
    new RegExp(`${SEPARATOR_PATTERN}\.git(:?${SEPARATOR_PATTERN}|$)`),
    new RegExp(`${SEPARATOR_PATTERN}\.DS_Store`),
  ];

  console.log(`Publishing '${resolve(rootPath)}'`);

  const stream: ReadableStream<Chunk> = ReadableStream.from(
    walk(rootPath, { skip: excludes }),
  )
    .pipeThrough(
      new TransformStream({
        async transform(chunk, controller) {
          const path = relative(rootPath, chunk.path);
          const relativePath = join(
            "source",
            path + (chunk.isDirectory ? "/" : ""),
          );
          if (gitignore.denies(relativePath)) {
            return;
          }

          if (!chunk.isDirectory) {
            const data = await Deno.readFile(chunk.path);

            const hashBuffer = await crypto.subtle.digest("SHA-256", data!);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hash = hashArray.map((b) => b.toString(16).padStart(2, "0"))
              .join("");

            controller.enqueue({
              chunk,
              relativePath,
              data,
              hash,
            });
          } else {
            controller.enqueue({
              chunk,
              relativePath,
            });
          }
        },
      }),
    );

  const [counter, body] = stream.tee();

  const manifest: Record<string, string> = {};
  let total = 0;

  const hashesSpinner = new Spinner({
    message: "Generating hashes...",
  });
  hashesSpinner.start();
  for await (const { chunk, hash, relativePath } of counter) {
    if (!chunk.isDirectory) {
      total++;
      const parts = relativePath.split("/");
      parts.shift();
      manifest[parts.join("/")] = hash!;
    }
  }
  hashesSpinner.stop();

  const trpcClient = createTrpcClient(debug, deployUrl);

  // deno-lint-ignore no-explicit-any
  const revisionId: string = await (trpcClient.apps as any).initiateCliRevision
    .mutate({
      org,
      app,
      production: prod,
      manifest,
    });

  // doing this after we initiate the cli revision in case it fails (ie app not existing).
  console.log(`${green("✔")} Generated hashes`);

  console.log(
    `You can view your application overview here:\n  ${deployUrl}/${org}/${app}`,
  );
  console.log(
    `You can view the revision here:\n  ${deployUrl}/${org}/${app}/builds/${revisionId}`,
  );
  console.log();

  const missingHashesPromise = Promise.withResolvers<string[]>();

  const existingFilesSpinner = new Spinner({
    message: "Loading previously uploaded files...",
  });
  existingFilesSpinner.start();

  // deno-lint-ignore no-explicit-any
  const sub = await (trpcClient.revisions as any).watchUntilReady.subscribe({
    org,
    app,
    revision: revisionId,
  }, {
    onData: (data: { labels: Record<string, string> }) => {
      if ("deno.diffsync.missing_hashes" in data.labels) {
        missingHashesPromise.resolve(
          JSON.parse(data.labels["deno.diffsync.missing_hashes"]),
        );
        sub.unsubscribe();
      }
    },
    onError: (err: unknown) => {
      sub.unsubscribe();
      error(debug, Deno.inspect(err));
    },
    onStopped: () => {
      sub.unsubscribe();
    },
  });

  const missingHashes = await missingHashesPromise.promise;

  existingFilesSpinner.stop();
  console.log(`${green("✔")} Loaded previously uploaded files`);

  if (missingHashes.length > 0) {
    const skippedFilesCount = total - missingHashes.length;

    if (skippedFilesCount > 0) {
      console.log(
        `Found ${skippedFilesCount} already uploaded files, which will be skipped from uploading`,
      );
    }

    const progress = new ProgressBar({
      max: missingHashes.length,
      emptyChar: " ",
      fillChar: green("█"),
      formatter(formatter) {
        const minutes = (formatter.time / 1000 / 60 | 0).toString().padStart(
          2,
          "0",
        );
        const seconds = (formatter.time / 1000 % 60 | 0).toString().padStart(
          2,
          "0",
        );

        const length = formatter.max.toString().length;
        return `[${yellow(minutes)}:${
          yellow(seconds)
        }] ${formatter.progressBar} ${
          yellow(formatter.value.toString().padStart(length, " "))
        }/${yellow(formatter.max.toString())} files uploaded.`;
      },
    });

    const tarball = body
      .pipeThrough(
        new TransformStream({
          async transform({ chunk, relativePath, data, hash }, controller) {
            if (chunk.isDirectory) {
              controller.enqueue(
                {
                  type: "directory",
                  path: relativePath,
                } satisfies TarStreamDir,
              );
            } else if (missingHashes.includes(hash!)) {
              const stat = await Deno.stat(chunk.path);

              progress.value += 1;

              controller.enqueue(
                {
                  type: "file",
                  path: relativePath,
                  size: stat.size,
                  readable: ReadableStream.from([data!]),
                } satisfies TarStreamFile,
              );
            }
          },
        }),
      )
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream("gzip"));

    const resp = await authedFetch(
      debug,
      deployUrl,
      `api/diffsync/${org}/${app}/${revisionId}`,
      {
        method: "POST",
        headers: {
          "x-meta": JSON.stringify({
            org,
            app,
            production: prod,
          }),
        },
        body: tarball,
      },
    );

    await progress.stop();

    console.log();

    if (!resp.ok) {
      const resBody = await resp.json();
      error(debug, resBody.message, resp);
    }

    console.log("Successfully uploaded your application!");
  } else {
    console.log("No files were changed, so there is nothing to upload.");
  }
  console.log(
    "You may now cancel this command, or wait until your domains are printed out.",
  );

  const completionSpinner = new Spinner({
    message: "Awaiting revision to complete...",
  });
  completionSpinner.start();

  const completionPromise = Promise.withResolvers<void>();

  // deno-lint-ignore no-explicit-any
  const completionSub = await (trpcClient.revisions as any).watchUntilReady
    .subscribe({
      org,
      app,
      revision: revisionId,
    }, {
      onData: (newRevision: { steps: { step: string }[] }) => {
        const lastStep = newRevision.steps.at(-1);

        if (lastStep) {
          completionSpinner.message = lastStep.step;
        }
      },
      onError: (err: unknown) => {
        completionSub.unsubscribe();
        error(debug, Deno.inspect(err));
      },
      onComplete: () => {
        completionPromise.resolve();
        completionSub.unsubscribe();
      },
      onStopped: () => {
        completionSub.unsubscribe();
      },
    });

  await completionPromise.promise;

  completionSpinner.stop();
  console.log(`\n${green("✔")} Successfully deployed your application!`);

  const timelines: Array<{ partition_config_name: string; domains: string[] }> =
    // deno-lint-ignore no-explicit-any
    await (trpcClient.revisions as any).listTimelines.query({
      org,
      app,
      revision: revisionId,
    });

  for (const timeline of timelines) {
    console.log(
      `${timeline.partition_config_name} url:${
        timeline.domains.map((domain) => `\n  https://${domain}`)
      }`,
    );
  }

  await writeConfig(configContent, org, app);
}
