import { TarStream, type TarStreamDir, type TarStreamFile } from "@std/tar";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { Spinner } from "@std/cli/unstable-spinner";
import { join, relative, resolve, SEPARATOR } from "@std/path";
import { green, red, yellow } from "@std/fmt/colors";
import { authedFetch, createTrpcClient } from "../auth.ts";
import { error } from "../util.ts";
import type { GlobalContext } from "../main.ts";
import type { ConfigContext } from "../config.ts";

const SEPARATOR_PATTERN = Deno.build.os === "windows" ? "\\\\" : "/";

interface Revision {
  labels: Record<string, string>;
  steps: { step: string }[];
  status: "cancelled" | "failed";
}

type Chunk = {
  relativePath: string;
  internalPath: string;
  hash: string;
  data: Uint8Array;
};

export async function publish(
  context: GlobalContext,
  configContext: ConfigContext,
  rootPath: string,
  org: string,
  app: string,
  prod: boolean,
  allowNodeModules: boolean,
  wait: boolean,
) {
  console.log(configContext.files);

  const excludes = [];

  if (!allowNodeModules) {
    excludes.push(
      new RegExp(`${SEPARATOR_PATTERN}node_modules(:?${SEPARATOR_PATTERN}|$)`),
    );
  }

  const spinner = new Spinner({
    message: `Publishing '${resolve(rootPath)}'`,
    color: "yellow",
  });
  spinner.start();

  const stream: ReadableStream<Chunk> = ReadableStream.from(configContext.files)
    .pipeThrough(
      new TransformStream({
        async transform(path, controller) {
          const relativePath = relative(rootPath, path);
          const internalPath = join("source", relativePath).replaceAll(SEPARATOR, "/");

          if (context.debug) {
            console.log(`reading ${JSON.stringify(relativePath)}`);
          }

          const data = await Deno.readFile(relativePath);

          const hashBuffer = await crypto.subtle.digest("SHA-256", data!);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const hash = hashArray.map((b) => b.toString(16).padStart(2, "0"))
            .join("");

          controller.enqueue({
            relativePath,
            internalPath,
            data,
            hash,
          });
        },
      }),
    );

  const [counter, body] = stream.tee();

  const manifest: Record<string, string> = {};
  let total = 0;

  spinner.message = "Generating hashes...";

  for await (const { hash, relativePath } of counter) {
    total++;
    const parts = relativePath.split("/");
    parts.shift();
    manifest[parts.join("/")] = hash!;
  }

  if (context.debug) {
    console.log("Manifest", manifest);
  }

  const trpcClient = createTrpcClient(context);

  const revisionId = await trpcClient.mutation(
    "apps.initiateCliRevision",
    {
      org,
      app,
      production: prod,
      manifest,
    },
  ) as string;

  // doing this after we initiate the cli revision in case it fails (ie app not existing).
  spinner.message = `${green("✔")} Generated hashes`;
  spinner.stop();

  console.log(
    `You can view the revision here:\n  ${context.endpoint}/${org}/${app}/builds/${revisionId}\n`,
  );

  const missingHashesPromise = Promise.withResolvers<string[]>();

  const existingFilesSpinner = new Spinner({
    message: "Loading previously uploaded files...",
    color: "yellow",
  });
  existingFilesSpinner.start();

  let revision: Revision | undefined = undefined;
  const sub = trpcClient.subscription(
    "revisions.watchUntilReady",
    {
      org,
      app,
      revision: revisionId,
    },
    {
      onData: (data: unknown) => {
        const typedData = data as Revision;
        revision = typedData;
        if ("deno.diffsync.missing_hashes" in typedData.labels) {
          missingHashesPromise.resolve(
            JSON.parse(typedData.labels["deno.diffsync.missing_hashes"]),
          );
          sub.unsubscribe();
        }
      },
      onError: (err: unknown) => {
        sub.unsubscribe();
        error(context, Deno.inspect(err));
      },
      onStopped: () => {
        sub.unsubscribe();
      },
    },
  );

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

    if (context.debug) {
      console.log("Missing hashes", missingHashes);
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

    let tarball = body
      .pipeThrough(
        new TransformStream({
          async transform({ relativePath, data, hash }, controller) {
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

            if (context.debug) {
              console.log(
                `uploading ${JSON.stringify(relativePath)} (${
                  chunk.isDirectory ? "dir" : "file"
                })`,
              );
            }
          },
        }),
      )
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream("gzip"));

    if (context.debug) {
      const [tb1, tb2] = tarball.tee();
      tarball = tb1;
      const path = await Deno.makeTempFile({
        suffix: "debug.tar.gz",
      });
      await Deno.writeFile(path, tb2);
      console.log(`Created debug tarball at '${path}'`);
    }

    const resp = await authedFetch(
      context,
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
      error(context, resBody.message, resp);
    }

    console.log("Successfully uploaded your application!");
  } else {
    console.log("No files were changed, so there is nothing to upload.");
  }

  console.log();

  if (wait) {
    await waitForRevision(context, org, app, revisionId, revision);
  } else {
    console.log(
      "To see the deployment, go to the revision page and wait for the build to complete.",
    );
  }
}

export async function waitForRevision(
  context: GlobalContext,
  org: string,
  app: string,
  revisionId: string,
  revision?: Revision,
) {
  const trpcClient = createTrpcClient(context);

  console.log(
    "Waiting for deployment to complete, if you do not want this, pass the --no-wait flag.",
  );

  const completionSpinner = new Spinner({
    message: "Awaiting revision to complete...",
    color: "yellow",
  });
  completionSpinner.start();

  const completionPromise = Promise.withResolvers<void>();

  const completionSub = trpcClient.subscription(
    "revisions.watchUntilReady",
    {
      org,
      app,
      revision: revisionId,
    },
    {
      onData: (data: unknown) => {
        const newRevision = data as Revision;
        revision = newRevision;
        const lastStep = newRevision.steps.at(-1);

        if (lastStep) {
          completionSpinner.message = lastStep.step;
        }
      },
      onError: (err: unknown) => {
        completionSub.unsubscribe();
        error(context, Deno.inspect(err));
      },
      onComplete: () => {
        completionPromise.resolve();
        completionSub.unsubscribe();
      },
      onStopped: () => {
        completionSub.unsubscribe();
      },
    },
  );

  await completionPromise.promise;

  completionSpinner.stop();
  if (revision?.status === "cancelled" || revision?.status === "failed") {
    console.log(
      `\n${red("✗")} The revision ${
        revision.status === "cancelled" ? "was " : ""
      }${revision.status}.\n  Please view the revision in the dashboard for more information.`,
    );
    Deno.exit(1);
  }

  console.log(`\n${green("✔")} Successfully deployed your application!`);

  const timelines = await trpcClient.query("revisions.listTimelines", {
    org,
    app,
    revision: revisionId,
  }) as Array<{ partition_config_name: string; domains: string[] }>;

  for (const timeline of timelines) {
    console.log(
      `${timeline.partition_config_name} url:${
        timeline.domains.map((domain) => `\n  https://${domain}`)
      }`,
    );
  }
}
