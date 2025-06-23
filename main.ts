import { parseArgs } from "@std/cli";
import { join } from "@std/path";
import { parse as parseJSONC } from "jsonc-parser";
import { publish } from "./publish.ts";
import { red } from "@std/fmt/colors";
import { create } from "./create.ts";
import { withApp } from "./util.ts";
import {
  applyEdits as applyJSONCEdits,
  modify as modifyJSONC,
} from "jsonc-parser";
import { setupAws } from "./setup-cloud.ts";

const args: { endpoint?: string } = parseArgs(Deno.args, {
  string: ["endpoint"],
});
export const deployUrl = args.endpoint ?? "https://app.deno.com";

const subcommand = Deno.args[0];

switch (subcommand) {
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
  case "setup-aws": {
    const args = parseArgs(Deno.args.slice(1), {
      string: ["app", "org"],
    });
    if (!args.org || !args.app) {
      console.error(
        `${
          red("✗")
        } Usage: deno deploy setup-aws --org <org> --app <app> [context1,context2,...]`,
      );
      Deno.exit(1);
    }
    const contexts = args._[0]?.toString();
    const contextList = contexts
      ? contexts.split(",").map((c) =>
        c.trim().toLowerCase().replaceAll(" ", "-")
      )
      : [];

    await setupAws(args.org, args.app, contextList);

    break;
  }
  default: {
    const args = parseArgs(Deno.args, {
      string: ["app", "org"],
    });
    const rootPath = args._[0]?.toString() || Deno.cwd();
    const configContent = await readConfig(rootPath);
    let { org, app } = getAppFromConfig(configContent);
    org ??= args.org;
    app ??= args.app;

    const orgAndApp = await withApp(org, app);

    if (orgAndApp.app === null) {
      await create(rootPath, configContent, orgAndApp.org);
    } else {
      await publish(rootPath, configContent, orgAndApp.org, orgAndApp.app);
    }
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

export async function writeConfig(
  configContent: Config | null,
  rootPath: string,
  org: string,
  app: string,
) {
  const content = configContent?.content ?? "{}\n";
  const edits = modifyJSONC(content, ["deploy"], {
    org,
    app,
  }, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  });
  const out = applyJSONCEdits(content, edits);
  await Deno.writeTextFile(
    configContent?.path ?? join(rootPath, "deno.jsonc"),
    out,
  );
}
