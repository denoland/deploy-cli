import { TarStream, type TarStreamFile } from "@std/tar";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { Spinner } from "@std/cli/unstable-spinner";
import { join, relative, resolve, SEPARATOR } from "@std/path";
import { green, red, yellow } from "@std/fmt/colors";
import { authedFetch, createTrpcClient } from "../auth.ts";
import { error } from "../util.ts";
import type { GlobalContext } from "../main.ts";
import type { ConfigContext } from "../config.ts";

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
  wait: boolean,
) {
  const quiet = context.quiet;
  // deno-lint-ignore no-explicit-any
  const log: typeof console.log = quiet
    ? () => {}
    : console.log.bind(console) as any;

  function startSpinner(message: string): Spinner {
    const spinner = new Spinner({ message, color: "yellow" });
    if (!quiet) spinner.start();
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
            console.log(`reading ${JSON.stringify(relativePath)}`);
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
  log(
    `You can view the revision here:\n  ${context.endpoint}/${org}/${app}/builds/${revisionId}\n`,
  );

  const missingHashesPromise = Promise.withResolvers<string[]>();

  const existingFilesSpinner = startSpinner(
    "Loading previously uploaded files...",
  );

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
  log(`${green("✔")} Loaded previously uploaded files`);

  if (missingHashes.length > 0) {
    const skippedFilesCount = configContext.files.length - missingHashes.length;

    if (skippedFilesCount > 0) {
      log(
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
          transform({ internalPath, data, hash }, controller) {
            if (missingHashes.includes(hash)) {
              if (!quiet) progress.value += 1;

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
              console.log(
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

    if (!quiet) await progress.stop();

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
    await waitForRevision(context, org, app, revisionId, revision);
  } else {
    log(
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
  const quiet = context.quiet;
  // deno-lint-ignore no-explicit-any
  const log: typeof console.log = quiet
    ? () => {}
    : console.log.bind(console) as any;
  const trpcClient = createTrpcClient(context);

  log(
    "Waiting for deployment to complete, if you do not want this, pass the --no-wait flag.",
  );

  const completionSpinner = new Spinner({
    message: "Awaiting revision to complete...",
    color: "yellow",
  });
  if (!quiet) completionSpinner.start();

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

  const timelines = await trpcClient.query("revisions.listTimelines", {
    org,
    app,
    revision: revisionId,
  }) as Array<{ partition_config_name: string; domains: string[] }>;

  console.log(`\n${green("✔")} Successfully deployed your application!`);

  for (const timeline of timelines) {
    console.log(
      `${timeline.partition_config_name} url:${
        timeline.domains.map((domain) => `\n  https://${domain}`)
      }`,
    );
  }
}
