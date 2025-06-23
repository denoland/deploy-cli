import { join } from "@std/path";
import { parse as parseJSONC,   applyEdits as applyJSONCEdits,
  modify as modifyJSONC,
} from "jsonc-parser";

export interface Config {
  path: string;
  content: string;
}

export async function readConfig(rootPath: string): Promise<Config | null> {
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

export function getAppFromConfig(configContent: Config | null): { org: undefined | string; app: undefined | string } {
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
