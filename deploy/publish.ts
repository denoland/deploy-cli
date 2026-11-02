import { TarStream, type TarStreamFile } from "@std/tar";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { Spinner } from "@std/cli/unstable-spinner";
import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { green, red, yellow } from "@std/fmt/colors";
import { authedFetch, createTrpcClient, type TRPCClient } from "../auth.ts";
import {
  error,
  type ErrorOptions,
  ExitCode,
  selectProductionUrl,
  shouldUseSpinner,
  writeJsonResult,
} from "../util.ts";
import type { GlobalContext } from "../main.ts";
import type { ConfigContext } from "../config.ts";
import type { AppDetail } from "./apps.ts";

export interface Revision {
  labels: Record<string, string>;
  steps: { step: string }[];
  status: "building" | "routeable" | "routed" | "cancelled" | "failed";
  /** Set by the console when a failed build could be classified. */
  build_failure?: { kind: string; message: string } | null;
}

/**
 * The label the console sets on a diff-sync revision once the builder has
 * compared the uploaded manifest against its cache: a JSON-encoded array of
 * the hashes whose files the CLI still has to upload (`"[]"` when none).
 */
export const MISSING_HASHES_LABEL = "deno.diffsync.missing_hashes";

/**
 * How long to wait for the builder to report which files to upload. The
 * report arrives while the build is still preparing, long before any build
 * timeout, so a wait this long means the build never started.
 */
export const MISSING_HASHES_TIMEOUT_MS = 10 * 60 * 1000;

export type MissingHashesFailure =
  /** The revision failed or was cancelled before the builder reported. */
  | { reason: "revision_terminal"; revision: Revision }
  /** The server ended the stream without the label or a terminal status. */
  | { reason: "stream_ended"; revision: Revision | undefined }
  /** No report within `timeoutMs`. */
  | { reason: "timeout"; revision: Revision | undefined; timeoutMs: number }
  /** A snapshot without labels, or a label that is not a JSON array of strings. */
  | { reason: "malformed_label"; revision: Revision | undefined; value: string }
  /** The subscription itself failed. */
  | {
    reason: "subscription_error";
    revision: Revision | undefined;
    error: unknown;
  };

export class MissingHashesError extends Error {
  constructor(readonly failure: MissingHashesFailure) {
    super(`missing hashes unavailable: ${failure.reason}`);
    this.name = "MissingHashesError";
  }
}

function parseMissingHashes(value: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) &&
      parsed.every((hash) => typeof hash === "string")
    ? parsed
    : undefined;
}

function isTerminal(revision: Revision): boolean {
  return revision.status === "failed" || revision.status === "cancelled";
}

/**
 * Watches the revision until the console publishes the hashes the builder is
 * missing (see {@link MISSING_HASHES_LABEL}). Settles on every exit of the
 * stream: the label makes it resolve; a terminal revision, the stream ending,
 * a subscription error, or the timeout reject with a {@link MissingHashesError}
 * naming the cause, so the deploy fails with a message instead of waiting on
 * a stream that will never deliver.
 */
export function waitForMissingHashes(
  trpcClient: TRPCClient,
  input: { org: string; app: string; revision: string },
  { timeoutMs = MISSING_HASHES_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ missingHashes: string[]; revision: Revision }> {
  const { promise, resolve, reject } = Promise.withResolvers<
    { missingHashes: string[]; revision: Revision }
  >();
  let revision: Revision | undefined;
  // Assigned once `subscription` returns; a callback may run before that.
  let sub: { unsubscribe(): void } | undefined = undefined;
  let settled = false;

  const timer = setTimeout(() => {
    fail({ reason: "timeout", revision, timeoutMs });
  }, timeoutMs);

  function finish() {
    settled = true;
    clearTimeout(timer);
    sub?.unsubscribe();
  }
  function fail(failure: MissingHashesFailure) {
    if (settled) return;
    finish();
    reject(new MissingHashesError(failure));
  }
  // The console ends the stream once the revision is terminal, so a stream
  // that ends after a failed or cancelled snapshot is reported as that.
  function streamEnded() {
    fail(
      revision !== undefined && isTerminal(revision)
        ? { reason: "revision_terminal", revision }
        : { reason: "stream_ended", revision },
    );
  }

  sub = trpcClient.subscription("revisions.watchUntilReady", input, {
    onData: (data: unknown) => {
      if (settled) return;
      const labels = (data as Partial<Revision> | null)?.labels;
      if (
        typeof labels !== "object" || labels === null || Array.isArray(labels)
      ) {
        fail({
          reason: "malformed_label",
          revision,
          value: Deno.inspect(data),
        });
        return;
      }
      revision = data as Revision;
      if (MISSING_HASHES_LABEL in revision.labels) {
        const value = revision.labels[MISSING_HASHES_LABEL];
        const missingHashes = parseMissingHashes(value);
        if (missingHashes === undefined) {
          fail({ reason: "malformed_label", revision, value });
          return;
        }
        finish();
        resolve({ missingHashes, revision });
      } else if (isTerminal(revision)) {
        // The builder reports before the build runs, so a revision that ended
        // without the label will never carry it.
        fail({ reason: "revision_terminal", revision });
      }
    },
    // The CLI's tRPC client (`auth.ts`) reports and exits on errors in its
    // error link, so this only runs for a client built without that link; it
    // settles the wait either way.
    onError: (err: unknown) => {
      fail({ reason: "subscription_error", revision, error: err });
    },
    onStopped: streamEnded,
    onComplete: streamEnded,
  });
  // A callback may have settled the wait before `subscription` returned.
  if (settled) sub.unsubscribe();

  return promise;
}

/**
 * The error to report for a {@link MissingHashesFailure}: a message naming
 * what happened, with the revision's console URL as the hint so the build
 * logs are one click away.
 */
export function describeMissingHashesFailure(
  failure: MissingHashesFailure,
  revisionUrl: string,
): { message: string } & ErrorOptions {
  const hint = `View ${revisionUrl} for details.`;
  switch (failure.reason) {
    case "revision_terminal": {
      const { status, build_failure } = failure.revision;
      const detail = build_failure?.message ? `\n${build_failure.message}` : "";
      return {
        message: `The revision ${
          status === "cancelled" ? "was cancelled" : "failed"
        } before the upload could start.${detail}`,
        code: ExitCode.GENERIC,
        errorCode: status === "cancelled"
          ? "REVISION_CANCELLED"
          : "REVISION_FAILED",
        hint,
      };
    }
    case "stream_ended":
      return {
        message:
          "The server closed the revision stream before reporting which files need uploading.",
        code: ExitCode.NETWORK,
        errorCode: "DIFFSYNC_STREAM_ENDED",
        hint:
          `The revision may have been cancelled or superseded by another deploy. ${hint} Then retry the deploy.`,
      };
    case "timeout":
      return {
        message: `Timed out after ${
          Math.round(failure.timeoutMs / 60_000)
        } minutes waiting for the build to report which files need uploading.`,
        code: ExitCode.NETWORK,
        errorCode: "DIFFSYNC_TIMEOUT",
        hint:
          `The build may be stuck or queued. ${hint} Then retry the deploy.`,
      };
    case "malformed_label":
      return {
        message:
          `The server reported the files to upload in an unexpected format: ${failure.value}`,
        code: ExitCode.NETWORK,
        errorCode: "DIFFSYNC_MALFORMED_RESPONSE",
        hint,
      };
    case "subscription_error":
      return {
        message:
          `The revision stream failed before reporting which files need uploading: ${
            Deno.inspect(failure.error)
          }`,
        code: ExitCode.NETWORK,
        errorCode: "DIFFSYNC_SUBSCRIPTION_ERROR",
        hint: `${hint} Then retry the deploy.`,
      };
  }
}

type Chunk = {
  relativePath: string;
  internalPath: string;
  hash: string;
  data: Uint8Array;
};

const DENO_JSON_NAMES = new Set(["deno.json", "deno.jsonc"]);

/**
 * Normalizes an app's stored build directory as the console does: `.` and
 * empty segments are dropped, and a path leaving the deploy root (which the
 * console rejects) becomes the root, "".
 */
export function normalizeBuildDirectory(buildDirectory: string): string {
  const segments = buildDirectory.split(/[\\/]/).filter((p) =>
    p !== "" && p !== "."
  );
  return segments.includes("..") ? "" : segments.join("/");
}

/**
 * The deno.json files to send with a CLI revision. The console reads the
 * `deploy` section of the deno.json in the app's build directory, as it does
 * for GitHub deployments, so it applies on every deploy rather than only when
 * the app is created; it reads no other config, so only that directory's are
 * sent. A config selected with `--config` stands in for it, and one the upload
 * leaves out through `deploy.include`/`exclude` (e.g. `"include": ["dist/**"]`)
 * still applies, so it is read from disk.
 */
export async function collectDenoJsonFiles(
  { rootPath, buildDirectory, uploaded, configPath }: {
    rootPath: string;
    /** The app's stored build directory, as stored. */
    buildDirectory: string;
    /** The uploaded deno.json/deno.jsonc files, by `/`-separated path. */
    uploaded: Record<string, string>;
    configPath?: string;
  },
): Promise<Record<string, string>> {
  const appDir = normalizeBuildDirectory(buildDirectory);
  const prefix = appDir === "" ? "" : `${appDir}/`;
  const files: Record<string, string> = {};
  for (const name of DENO_JSON_NAMES) {
    if (`${prefix}${name}` in uploaded) {
      files[`${prefix}${name}`] = uploaded[`${prefix}${name}`];
    }
  }
  if (configPath) {
    delete files[`${prefix}deno.jsonc`];
    files[`${prefix}deno.json`] = await Deno.readTextFile(configPath);
    return files;
  }
  // Symlinks are resolved first, so that neither the app directory nor the
  // config can point outside the deploy root.
  const root = await Deno.realPath(rootPath);
  for (const name of DENO_JSON_NAMES) {
    if (`${prefix}${name}` in files) continue;
    let path;
    try {
      path = await Deno.realPath(join(rootPath, appDir, name));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    const fromRoot = relative(root, path);
    if (
      fromRoot === ".." || fromRoot.startsWith(`..${SEPARATOR}`) ||
      isAbsolute(fromRoot)
    ) {
      continue;
    }
    files[`${prefix}${name}`] = await Deno.readTextFile(path);
  }
  return files;
}

/**
 * The app's stored build directory, as stored (see `normalizeBuildDirectory`).
 * A failure here (e.g. a missing app) is reported and exits just as
 * `apps.initiateCliRevision` would have.
 */
async function appBuildDirectory(
  context: GlobalContext,
  org: string,
  app: string,
): Promise<string> {
  const fullApp = await createTrpcClient(context).query("apps.get", {
    org,
    app,
  }) as AppDetail;
  return fullApp.build_config?.buildDirectory ?? "";
}

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
  const uploadedDenoJsonFiles: Record<string, string> = {};

  spinner.message = "Generating hashes...";

  for await (const { hash, relativePath, data } of counter) {
    const path = relativePath.replaceAll(SEPARATOR, "/");
    manifest[path] = hash;
    if (DENO_JSON_NAMES.has(path.slice(path.lastIndexOf("/") + 1))) {
      uploadedDenoJsonFiles[path] = new TextDecoder().decode(data);
    }
  }

  const denoJsonFiles = await collectDenoJsonFiles({
    rootPath,
    buildDirectory: await appBuildDirectory(context, org, app),
    uploaded: uploadedDenoJsonFiles,
    configPath: context.config,
  });

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
      denoJsonFiles,
    },
  ) as string;

  // doing this after we initiate the cli revision in case it fails (ie app not existing).
  spinner.message = `${green("✔")} Generated hashes`;
  spinner.stop();
  log(
    `You can view the revision here:\n  ${context.endpoint}/${org}/${app}/builds/${revisionId}\n`,
  );

  const existingFilesSpinner = startSpinner(
    "Loading previously uploaded files...",
  );

  let missingHashes: string[];
  let revision: Revision | undefined;
  try {
    ({ missingHashes, revision } = await waitForMissingHashes(trpcClient, {
      org,
      app,
      revision: revisionId,
    }));
  } catch (err) {
    existingFilesSpinner.stop();
    if (!(err instanceof MissingHashesError)) throw err;
    if (context.debug) console.error(err.failure);
    const { message, ...opts } = describeMissingHashesFailure(
      err.failure,
      `${context.endpoint}/${org}/${app}/builds/${revisionId}`,
    );
    error(context, message, opts);
  }

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
    await waitForRevision(context, org, app, revisionId, revision);
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

export async function waitForRevision(
  context: GlobalContext,
  org: string,
  app: string,
  revisionId: string,
  revision?: Revision,
) {
  const quiet = context.quiet || context.json;
  const log: typeof console.log = quiet
    ? () => {}
    // deno-lint-ignore no-explicit-any
    : console.error.bind(console) as any;
  const trpcClient = createTrpcClient(context);

  log(
    "Waiting for deployment to complete, if you do not want this, pass the --no-wait flag.",
  );

  const completionSpinner = new Spinner({
    message: "Awaiting revision to complete...",
    color: "yellow",
  });
  if (shouldUseSpinner(context)) completionSpinner.start();

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
    if (context.json) {
      error(context, `The revision ${revision.status}.`, {
        code: 1,
        errorCode: revision.status === "cancelled"
          ? "REVISION_CANCELLED"
          : "REVISION_FAILED",
        hint:
          `View ${context.endpoint}/${org}/${app}/builds/${revisionId} for details.`,
      });
    }
    console.error(
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
  }) as Array<
    { partition_config_name: string; context_name: string; domains: string[] }
  >;

  const { productionUrl } = selectProductionUrl(timelines);

  if (context.json) {
    writeJsonResult({
      org,
      app,
      revisionId,
      url: `${context.endpoint}/${org}/${app}/builds/${revisionId}`,
      status: revision?.status ?? "ready",
      productionUrl,
      timelines: timelines.map((t) => ({
        partition: t.partition_config_name,
        domains: t.domains.map((d) => `https://${d}`),
      })),
    });
    return;
  }

  console.error(`\n${green("✔")} Successfully deployed your application!`);

  for (const timeline of timelines) {
    console.error(
      `${timeline.partition_config_name} url:${
        timeline.domains.map((domain) => `\n  https://${domain}`)
      }`,
    );
  }
}
