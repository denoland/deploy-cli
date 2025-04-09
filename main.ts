import { TarStream, type TarStreamDir, type TarStreamFile } from "@std/tar";
import { compile as gitignoreCompile } from "@cfa/gitignore-parser";
import { walk } from "@std/fs";
import { parseArgs } from "@std/cli";
import { ProgressBar } from "@std/cli/unstable-progress-bar";
import { promptSelect } from "@std/cli/unstable-prompt-select";
import { join, relative } from "@std/path";
import {
  applyEdits as applyJSONCEdits,
  modify as modifyJSONC,
  parse as parseJSONC,
} from "jsonc-parser";
import { green, yellow } from "@std/fmt/colors";
import { deployToken, deployUrl, trpcClient } from "./auth.ts";

const args = parseArgs(Deno.args, {
  string: ["app", "org"],
});

const rootPath = args._[0]?.toString() || Deno.cwd();

async function readConfig() {
  try {
    const path = join(rootPath, "deno.json");
    const content = await Deno.readTextFile(path);
    return { path, content };
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }

  try {
    const path = join(rootPath, "deno.jsonc");
    const content = await Deno.readTextFile(path);
    return { path, content };
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }

  return null;
}

const configContent = await readConfig();

let org;
let app;
if (configContent) {
  const config = parseJSONC(configContent.content);
  if (
    typeof config === "object" && config !== null && "deploy" in config &&
    typeof config.deploy === "object" && config.deploy !== null &&
    !Array.isArray(config.deploy)
  ) {
    org = config.deploy.org;
    app = config.deploy.app;
  }
}

org ??= args.org;
app ??= args.app;

if (!org || !app) {
  const orgs = await trpcClient.orgs.list.query();

  const orgStrings = orgs.map((org) => `${org.name} (${org.slug})`);
  const orgsResult = promptSelect("select an organization:", orgStrings, {
    clear: true,
  });
  if (!orgsResult) {
    console.error("No organization was selected.");
    Deno.exit(1);
  }

  const selectedOrg = orgs[orgStrings.indexOf(orgsResult)];
  org = selectedOrg.slug;
  console.log(`Selected organization '${selectedOrg.name}'`);

  const apps = await trpcClient.apps.list.query({
    org: selectedOrg.id,
  });
  const appStrings = apps.map((app) => `${app.slug}`);
  const appsResult = promptSelect("select an application:", appStrings, {
    clear: true,
  });
  if (!appsResult) {
    console.error("No organization was selected.");
    Deno.exit(1);
  }

  const selectedApp = apps[appStrings.indexOf(appsResult)];
  app = selectedApp.slug;
  console.log(`Selected app '${selectedApp.slug}'`);
}

if (!org) {
  console.error(
    "Expected 'deploy.org' in the config file or the '--org' flag to be specified.",
  );
  Deno.exit(1);
}
if (!app) {
  console.error(
    "Expected 'deploy.app' in the config file or the '--app' flag to be specified.",
  );
  Deno.exit(1);
}

let gitignore: any = {
  denies: () => false,
};

try {
  gitignore = gitignoreCompile(
    Deno.readTextFileSync(join(rootPath, ".gitignore")),
  );
} catch (_) {
  //
}

const excludes = [/node_modules/, /.git/, /.DS_Store/];

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
    return `[${yellow(minutes)}:${yellow(seconds)}] ${formatter.progressBar} ${
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

const resp = await fetch(`${deployUrl}/api/trigger_tarball_build`, {
  method: "POST",
  headers: {
    "x-meta": JSON.stringify({
      org,
      app,
    }),
    "cookie": `token=${deployToken}`,
  },
  body: tarball,
});

const { revisionId } = await resp.json();

await progress.end();

console.log("Successfully uploaded tarball!");
console.log(
  `You can view the revision here:\n${deployUrl}/${org}/${app}/builds/${revisionId}`,
);

if (configContent) {
  const edits = modifyJSONC(configContent.content, ["deploy"], {
    org,
    app,
  }, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  });
  const out = applyJSONCEdits(configContent.content, edits);
  await Deno.writeTextFile(configContent.path, out);
}
