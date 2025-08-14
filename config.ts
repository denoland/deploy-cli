import { dirname, join } from "@std/path";
import {
  applyEdits as applyJSONCEdits,
  modify as modifyJSONC,
  parse as parseJSONC,
} from "jsonc-parser";

export interface Config {
  path: string;
  content: string;
}

export async function readConfig(
  rootPath: string,
  maybeConfigPath: string | undefined,
): Promise<Config | null> {
  if (maybeConfigPath) {
    const content = await Deno.readTextFile(maybeConfigPath);
    return { path: maybeConfigPath, content };
  }

  let currentDir = rootPath;

  while (true) {
    try {
      const path = join(currentDir, "deno.json");
      const content = await Deno.readTextFile(path);
      return { path, content };
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }

    try {
      const path = join(currentDir, "deno.jsonc");
      const content = await Deno.readTextFile(path);
      return { path, content };
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }

    const parentDir = dirname(currentDir);

    if (parentDir == currentDir) {
      break;
    } else {
      currentDir = parentDir;
    }
  }

  return null;
}

export function getAppFromConfig(
  configContent: Config | null,
): { org: undefined | string; app: undefined | string } {
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
    configContent?.path ?? join(Deno.cwd(), "deno.jsonc"),
    out,
  );

  if (!configContent) {
    console.log(
      `Created configuration file at '${join(Deno.cwd(), "deno.jsonc")}'`,
    );
  }
}
