import {
  detectBuildConfig,
  FrameworkFileSystemReader,
} from "@deno/framework-detect";
import { deployUrl, interactive, tokenExchange } from "./auth.ts";
import open from "open";
import { Spinner } from "@std/cli/unstable-spinner";
import { publish } from "./publish.ts";
import { green } from "@std/fmt/colors";
import type { Config } from "./main.ts";

export async function create(rootPath: string, configContent: Config | null) {
  let deployToken = Deno.env.get("DEPLOY_TOKEN");
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

  if (!deployToken) {
    const res = await interactive();
    url.searchParams.set("code", res.code);
    verifier = res.verifier;
    exchangeToken = res.exchangeToken;
  }

  console.log(`Visit ${url.href} to create a new app.\x07`);
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

  const [{ org, app }, newToken] = await Promise.all([
    appCreationPromise,
    deployToken ? undefined : tokenExchange(exchangeToken!, verifier!, spinner),
  ]);

  if (newToken) {
    deployToken = newToken;
  }

  spinner.stop();
  console.log(`${green("✔")} App '${app}' created in the '${org}' org.\n`);

  await publish(rootPath, configContent, deployToken!, org, app);
}
