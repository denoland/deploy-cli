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
  deployUrl: string,
  rootPath: string,
  configContent: Config | null,
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
    const res = await interactive(deployUrl);
    url.searchParams.set("code", res.code);
    verifier = res.verifier;
    exchangeToken = res.exchangeToken;
  }

  console.log(`Visit ${url.href} to create a new application.\x07`);
  const spinner = new Spinner({ message: "Waiting...", color: "yellow" });
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
    storedAuth
      ? undefined
      : tokenExchange(deployUrl, exchangeToken!, verifier!, spinner),
  ]);

  spinner.stop();
  console.log(
    `${green("✔")} App '${app}' created in the '${org}' organization.\n`,
  );

  await publish(deployUrl, rootPath, configContent, org, app, true);
}
