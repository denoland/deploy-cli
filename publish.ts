import { TarStream, type TarStreamDir, type TarStreamFile } from "@std/tar";
import { compile as gitignoreCompile } from "@cfa/gitignore-parser";
import { walk } from "@std/fs";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { join, relative, resolve } from "@std/path";
import { green, yellow } from "@std/fmt/colors";
import { type Config, writeConfig } from "./config.ts";
import { authedFetch } from "./auth.ts";
import { error } from "./util.ts";

const SEPARATOR_PATTERN = Deno.build.os === "windows" ? "\\\\" : "/";

export async function publish(
  deployUrl: string,
  rootPath: string,
  configContent: Config | null,
  org: string,
  app: string,
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

  const stream = ReadableStream.from(walk(rootPath, { skip: excludes }))
    .pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          const path = relative(rootPath, chunk.path);
          const relativePath = join(
            "source",
            path + (chunk.isDirectory ? "/" : ""),
          );
          if (gitignore.denies(relativePath)) {
            return;
          }

          console.log(relativePath);

          controller.enqueue({ chunk, relativePath });
        },
      }),
    );

  const [counter, body] = stream.tee();

  let total = 0;
  for await (const { chunk } of counter) {
    if (!chunk.isDirectory) {
      total++;
    }
  }

  const progress = new ProgressBar(Deno.stdout.writable, {
    max: total,
    emptyChar: " ",
    fillChar: green("█"),
    fmt(formatter) {
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
        async transform({ chunk, relativePath }, controller) {
          if (chunk.isDirectory) {
            controller.enqueue(
              {
                type: "directory",
                path: relativePath,
              } satisfies TarStreamDir,
            );
          } else {
            const [stat, file] = await Promise.all([
              Deno.stat(chunk.path),
              Deno.open(chunk.path),
            ]);

            controller.enqueue(
              {
                type: "file",
                path: relativePath,
                size: stat.size,
                readable: file.readable.pipeThrough(
                  new TransformStream({
                    flush() {
                      progress.add(1);
                    },
                  }),
                ),
              } satisfies TarStreamFile,
            );
          }
        },
      }),
    )
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));

  const resp = await authedFetch(deployUrl, `/api/trigger_tarball_build`, {
    method: "POST",
    headers: {
      "x-meta": JSON.stringify({
        org,
        app,
      }),
    },
    body: tarball,
  });

  const resBody = await resp.json();

  await progress.end();

  if (!resp.ok) {
    error(resBody.message, resp);
  } else {
    console.log("Successfully uploaded your app!");
    console.log(
      `You can view your app overview here:\n  ${deployUrl}/${org}/${app}`,
    );
    console.log(
      `You can view the revision here:\n  ${deployUrl}/${org}/${app}/builds/${resBody.revisionId}`,
    );
    // TODO: print out the preview url

    await writeConfig(configContent, rootPath, org, app);
  }
}
