import { TarStream, type TarStreamDir, type TarStreamFile } from "@std/tar";
import { compile as gitignoreCompile } from "@cfa/gitignore-parser";
import { walk, type WalkEntry } from "@std/fs";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { Spinner } from "@std/cli/unstable-spinner";
import { join, relative, resolve } from "@std/path";
import { green, yellow } from "@std/fmt/colors";
import { type Config, writeConfig } from "./config.ts";
import { authedFetch } from "./auth.ts";
import { error } from "./util.ts";

const SEPARATOR_PATTERN = Deno.build.os === "windows" ? "\\\\" : "/";

type Chunk =
  & { chunk: WalkEntry; relativePath: string }
  & ({ hash?: undefined; data?: undefined } | {
    hash: string;
    data: Uint8Array;
  });

export async function publish(
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
  console.log(`${green("✔")} Generated hashes`);

  const initiatedBuildRes = await authedFetch(deployUrl, "api/initiate_cli_build", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      org,
      app,
      production: prod,
      manifest,
    }),
  });

  const { revisionId }: { revisionId: string; } = await initiatedBuildRes.json();

  let missingHashes: string[];

  const s = Date.now();
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const maybeHashesRes = await authedFetch(deployUrl, `api/diffsync/${org}/${app}/${revisionId}`, {});
    if (maybeHashesRes.status !== 202) {
      if (maybeHashesRes.ok) {
        missingHashes = await maybeHashesRes.json();
        break;
      } else {
        const err = await maybeHashesRes.json();
        error(`Failed getting file hashes: ${err.message}`, maybeHashesRes);
      }
    }

    if ((Date.now() - s) >= 30 * 1000) {
      error(`Failed getting file hashes`, maybeHashesRes);
    }
  }

  if (missingHashes.length > 0) {
    const skippedFilesCount = total - missingHashes.length;

    if (skippedFilesCount > 0) {
      console.log(`Found ${skippedFilesCount} already uploaded files, which will be skipped from uploading`);
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

    const resp = await authedFetch(deployUrl, `api/diffsync/${org}/${app}/${revisionId}`, {
      method: "POST",
      headers: {
        "x-meta": JSON.stringify({
          org,
          app,
          production: prod,
        }),
      },
      body: tarball,
    });

    await progress.stop();

    console.log();

    if (!resp.ok) {
      const resBody = await resp.json();
      error(resBody.message, resp);
    }

    console.log("Successfully uploaded your application!");
  } else {
    console.log("No files were changed.");
  }

  console.log(
    `You can view your application overview here:\n  ${deployUrl}/${org}/${app}`,
  );
  console.log(
    `You can view the revision here:\n  ${deployUrl}/${org}/${app}/builds/${revisionId}`,
  );
  // TODO: print out the preview url

  await writeConfig(configContent, rootPath, org, app);

}
