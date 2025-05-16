import { parseArgs } from "@std/cli";
import { join } from "@std/path";
import { parse as parseJSONC } from "jsonc-parser";
import { publish } from "./publish.ts";
import { auth, createTrpcClient, withApp } from "./auth.ts";
import { red } from "@std/fmt/colors";
import { create } from "./create.ts";
import {
  applyEdits as applyJSONCEdits,
  modify as modifyJSONC,
} from "jsonc-parser";

const subcommand = Deno.args[0];

switch (subcommand) {
  case "publish": {
    const args = parseArgs(Deno.args.slice(1), {
      string: ["app", "org"],
    });
    const rootPath = args._[0]?.toString() || Deno.cwd();
    const configContent = await readConfig(rootPath);
    let { org, app } = getAppFromConfig(configContent);
    org ??= args.org;
    app ??= args.app;

    const deployToken = await auth();
    const trpcClient = createTrpcClient(deployToken);
    const orgAndApp = await withApp(trpcClient, org, app);

    await publish(
      rootPath,
      configContent,
      deployToken,
      orgAndApp.org,
      orgAndApp.app,
    );
    break;
  }
  case "create": {
    const args = parseArgs(Deno.args.slice(1), {});
    const rootPath = args._[0]?.toString() || Deno.cwd();
    const configContent = await readConfig(rootPath);
    const { org, app } = getAppFromConfig(configContent);
    if (org || app) {
      console.log(`${red("✗")} An app already exists in this directory.`);
      Deno.exit(1);
    }

    await create(rootPath, configContent);

    break;
  }
}

export interface Config {
  path: string;
  content: string;
}

async function readConfig(rootPath: string): Promise<Config | null> {
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

function getAppFromConfig(configContent: Config | null) {
  if (configContent) {
    const config = parseJSONC(configContent.content);
    if (
      typeof config === "object" && config !== null && "deploy" in config &&
      typeof config.deploy === "object" && config.deploy !== null &&
      !Array.isArray(config.deploy)
    ) {
      return {
        org: config.deploy.org,
        app: config.deploy.app,
      };
    }
  }

  return {
    org: undefined,
    app: undefined,
  };
}

export async function writeConfig(configContent: Config | null, org: string, app: string) {
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
}