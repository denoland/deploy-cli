import { TarStream, type TarStreamFile } from "@std/tar";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { Spinner } from "@std/cli/unstable-spinner";
import { join, relative, resolve, SEPARATOR } from "@std/path";
import { green, red, yellow } from "@std/fmt/colors";
import type { RevisionProgress } from "@deno/sandbox";
import { authedFetch, createTrpcClient } from "../auth.ts";
import {
  error,
  selectProductionUrlFromSdk,
  shouldUseSpinner,
  writeJsonResult,
} from "../util.ts";
import { deploySdkClient } from "./sdk.ts";
import type { GlobalContext } from "../main.ts";
import type { ConfigContext } from "../config.ts";

// Minimal shape of the tRPC `revisions.watchUntilReady` payload consumed by the
// diffsync missing-hashes probe below. The deployment-completion wait uses the
// typed `@deno/sandbox` SDK instead (see `waitForRevision`).
interface Revision {
  labels: Record<string, string>;
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
  wait: boolean,
) {
  const quiet = context.quiet || context.json;
  const log: typeof console.log = quiet
    ? () => {}
    // deno-lint-ignore no-explicit-any
    : console.error.bind(console) as any;

  function startSpinner(message: string): Spinner {
    const spinner = new Spinner({ message, color: "yellow" });
    if (shouldUseSpinner(context)) spinner.start();
    return spinner;
  }

  const spinner = startSpinner(`Publishing '${resolve(rootPath)}'`);

  const stream: ReadableStream<Chunk> = ReadableStream.from(configContext.files)
    .pipeThrough(
      new TransformStream({
        async transform(path, controller) {
          const relativePath = relative(rootPath, path);
          const internalPath = join("source", relativePath).replaceAll(
            SEPARATOR,
            "/",
          );

          if (context.debug) {
            console.error(`reading ${JSON.stringify(relativePath)}`);
          }

          const data = await Deno.readFile(path);

          const hashBuffer = await crypto.subtle.digest("SHA-256", data);
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

  spinner.message = "Generating hashes...";

  for await (const { hash, relativePath } of counter) {
    manifest[relativePath.replaceAll(SEPARATOR, "/")] = hash;
  }

  if (context.debug) {
    console.error("Manifest", manifest);
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
  log(
    `You can view the revision here:\n  ${context.endpoint}/${org}/${app}/builds/${revisionId}\n`,
  );

  const missingHashesPromise = Promise.withResolvers<string[]>();

  const existingFilesSpinner = startSpinner(
    "Loading previously uploaded files...",
  );

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
  log(`${green("✔")} Loaded previously uploaded files`);

  if (missingHashes.length > 0) {
    const skippedFilesCount = configContext.files.length - missingHashes.length;

    if (skippedFilesCount > 0) {
      log(
        `Found ${skippedFilesCount} already uploaded files, which will be skipped from uploading`,
      );
    }

    if (context.debug) {
      console.error("Missing hashes", missingHashes);
    }

    const useProgress = shouldUseSpinner(context);
    // Only instantiate when drawn; its render timer otherwise keeps the event
    // loop alive and hangs the process.
    const progress = useProgress
      ? new ProgressBar({
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
      })
      : undefined;

    let tarball = body
      .pipeThrough(
        new TransformStream({
          transform({ internalPath, data, hash }, controller) {
            if (missingHashes.includes(hash)) {
              if (progress) progress.value += 1;

              controller.enqueue(
                {
                  type: "file",
                  path: internalPath,
                  size: data.byteLength,
                  readable: ReadableStream.from([data]),
                } satisfies TarStreamFile,
              );
            }

            if (context.debug) {
              console.error(
                `uploading ${JSON.stringify(internalPath)}`,
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
      console.error(`Created debug tarball at '${path}'`);
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

    if (progress) await progress.stop();

    log();

    if (!resp.ok) {
      const resBody = await resp.json();
      error(context, resBody.message, resp);
    }

    log("Successfully uploaded your application!");
  } else {
    log("No files were changed, so there is nothing to upload.");
  }

  log();

  if (wait) {
    await waitForRevision(context, org, app, revisionId);
  } else if (context.json) {
    // Build isn't finished yet; emit the revision id so agents can track it.
    writeJsonResult({
      org,
      app,
      revisionId,
      url: `${context.endpoint}/${org}/${app}/builds/${revisionId}`,
      status: "pending",
      productionUrl: null,
    });
  } else {
    log(
      "To see the deployment, go to the revision page and wait for the build to complete.",
    );
  }
}

// The top-level revision-progress stages, in order, mapped to the short step
// labels the spinner used to show (matching the server's build step names).
const PROGRESS_STAGE_LABELS: ReadonlyArray<[keyof RevisionProgress, string]> = [
  ["queued", "queueing"],
  ["preparing", "preparing"],
  ["installing", "installing"],
  ["building", "building"],
  ["deploying", "routing"],
];

/**
 * Derive the current build step label from a {@linkcode RevisionProgress}
 * event: the furthest-progressed stage that has started (i.e. is not `pending`
 * or `skipped`). Returns `undefined` before any stage starts.
 */
function currentStageLabel(progress: RevisionProgress): string | undefined {
  let label: string | undefined;
  for (const [key, name] of PROGRESS_STAGE_LABELS) {
    const status = progress[key]?.status;
    if (status && status !== "pending" && status !== "skipped") {
      label = name;
    }
  }
  return label;
}

export async function waitForRevision(
  context: GlobalContext,
  org: string,
  app: string,
  revisionId: string,
) {
  const quiet = context.quiet || context.json;
  const log: typeof console.log = quiet
    ? () => {}
    // deno-lint-ignore no-explicit-any
    : console.error.bind(console) as any;
  const client = await deploySdkClient(context, org);

  log(
    "Waiting for deployment to complete, if you do not want this, pass the --no-wait flag.",
  );

  const completionSpinner = new Spinner({
    message: "Awaiting revision to complete...",
    color: "yellow",
  });
  if (shouldUseSpinner(context)) completionSpinner.start();

  // `revisions.progress` streams structured progress and ends when the revision
  // reaches a terminal state (succeeded / failed / skipped). The terminal
  // status itself is read separately via `revisions.get` below.
  try {
    for await (const progress of client.revisions.progress(revisionId)) {
      const label = currentStageLabel(progress);
      if (label) completionSpinner.message = label;
    }
  } catch (err) {
    completionSpinner.stop();
    error(context, Deno.inspect(err));
  }

  completionSpinner.stop();

  const revision = await client.revisions.get(revisionId);
  if (revision?.status === "failed") {
    const cancelled = revision.failure_reason === "cancelled";
    const statusWord = cancelled ? "cancelled" : "failed";
    if (context.json) {
      error(context, `The revision ${statusWord}.`, {
        code: 1,
        errorCode: cancelled ? "REVISION_CANCELLED" : "REVISION_FAILED",
        hint:
          `View ${context.endpoint}/${org}/${app}/builds/${revisionId} for details.`,
      });
    }
    console.error(
      `\n${red("✗")} The revision ${
        cancelled ? "was " : ""
      }${statusWord}.\n  Please view the revision in the dashboard for more information.`,
    );
    Deno.exit(1);
  }

  const timelines = await client.revisions.timelines(revisionId);

  const { productionUrl } = selectProductionUrlFromSdk(timelines);

  if (context.json) {
    writeJsonResult({
      org,
      app,
      revisionId,
      url: `${context.endpoint}/${org}/${app}/builds/${revisionId}`,
      status: revision?.status ?? "succeeded",
      productionUrl,
      timelines: timelines.map((t) => ({
        slug: t.slug,
        partition: t.partition,
        domains: t.domains.map((d) => `https://${d.domain}`),
      })),
    });
    return;
  }

  console.error(`\n${green("✔")} Successfully deployed your application!`);

  for (const timeline of timelines) {
    console.error(
      `${timeline.slug} url:${
        timeline.domains.map((d) => `\n  https://${d.domain}`)
      }`,
    );
  }
}
