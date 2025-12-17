import {
  detectBuildConfig,
  FrameworkFileSystemReader,
} from "@deno/framework-detect";
import { interactive, tokenExchange } from "./auth.ts";
import open from "open";
import { Spinner } from "@std/cli/unstable-spinner";
import { publish } from "./publish.ts";
import { green } from "@std/fmt/colors";
import type { Config } from "./config.ts";
import token_storage from "./token_storage.ts";

export async function create(
  debug: boolean,
  deployUrl: string,
  rootPath: string,
  configContent: Config | null,
  allowNodeModules: boolean,
  wait: boolean,
  initOrg?: string,
) {
  let verifier;
  let exchangeToken;

  const buildConfig = await detectBuildConfig(
    new FrameworkFileSystemReader(rootPath),
  );

  const deviceCreate = await fetch(`${deployUrl}/api/device_create`, {
    method: "POST",
    body: JSON.stringify({
      buildConfig,
    }),
  });
  const { id: deviceCreateId } = await deviceCreate.json();

  const url = new URL(`${deployUrl!}/device-create/${deviceCreateId}`);

  if (initOrg) {
    url.searchParams.set("org", initOrg);
  }

  const storedAuth = token_storage.get();

  if (!storedAuth) {
    const res = await interactive(debug, deployUrl);
    url.searchParams.set("code", res.code);
    verifier = res.verifier;
    exchangeToken = res.exchangeToken;
  }

  const spinner = new Spinner({
    message: `Visit ${url.href} to create a new application.`,
    color: "yellow",
  });
  spinner.start();

  await open(url.href);

  const appCreationPromise = new Promise<{ org: string; app: string }>(
    (resolve, reject) => {
      const interval = setInterval(async () => {
        const res = await fetch(
          `${deployUrl!}/api/device_create/${deviceCreateId}`,
          {
            method: "GET",
          },
        );

        if (res.ok) {
          const appCreation = await res.json();
          clearInterval(interval);
          resolve(appCreation);
        } else {
          const err = await res.json();
          if (err.code !== "APP_CREATION_REQUEST_PENDING") {
            clearInterval(interval);
            reject(new Error(err.message));
          }
        }
      }, 2000);
    },
  );

  const [{ org, app }] = await Promise.all([
    appCreationPromise,
    storedAuth ? undefined : tokenExchange(
      debug,
      deployUrl,
      exchangeToken!,
      verifier!,
      spinner,
      false,
    ),
  ]);

  spinner.stop();
  console.log(
    `${green("✔")} App '${app}' created in the '${org}' organization.\n`,
  );

  await publish(
    debug,
    deployUrl,
    rootPath,
    configContent,
    org,
    app,
    true,
    allowNodeModules,
    wait,
  );
}
