import type { TRPCCombinedDataTransformer } from "@trpc/server";
import { serialize } from "superjson";
import open from "open";
import { encodeBase64 } from "@std/encoding";
import { green, red } from "@std/fmt/colors";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCClient,
} from "@trpc/client";
import { Spinner } from "@std/cli/unstable-spinner";
import { promptSelect } from "@std/cli/unstable-prompt-select";

export const deployUrl = Deno.env.get("DEPLOY_URL") ?? "https://app.deno.com";

export function createTrpcClient(deployToken?: string) {
  const transformer: TRPCCombinedDataTransformer = {
    input: {
      serialize,
      deserialize: (_) => {/* this is never called on the client */},
    },
    output: {
      serialize: (_) => {/* this is never called on the client */},
      deserialize: (object) => (0, eval)(`(${object})`),
    },
  };

  return createTRPCClient<any>({
    links: [
      splitLink({
        // uses the httpSubscriptionLink for subscriptions
        condition: (op) => op.type === "subscription",
        false: httpBatchStreamLink({
          url: deployUrl + "/api",
          headers() {
            if (deployToken) {
              return {
                cookie: `token=${deployToken}`,
              };
            } else {
              return {};
            }
          },
          transformer,
        }),
        true: httpSubscriptionLink({
          url: deployUrl + "/api",
          transformer,
        }),
      }),
    ],
  });
}

export async function auth() {
  let deployToken = Deno.env.get("DEPLOY_TOKEN");

  if (!deployToken) {
    const { code, exchangeToken, verifier } = await interactive();

    const authUrl = `${deployUrl}/auth?code=${code}`;

    console.log(`Visit ${authUrl} to authorize uploading of tarball.\x07`);
    const spinner = new Spinner({ message: "Waiting...", color: "yellow" });
    spinner.start();

    await open(authUrl);

    deployToken = await tokenExchange(exchangeToken, verifier, spinner);
  }

  return deployToken!;
}

export async function interactive(): Promise<{ code: string; exchangeToken: string; verifier: string; }> {
  const verifier = crypto.randomUUID();
  const data = (new TextEncoder()).encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = encodeBase64(hash);

  const res = await fetch(`${deployUrl}/auth/interactive`, {
    method: "POST",
    body: JSON.stringify({ challenge }),
  });

  if (!res.ok) {
    console.error("An error occured, exiting...");
    Deno.exit(1);
  }

  const body = await res.json();

  return {
    code: body.code,
    exchangeToken: body.exchangeToken,
    verifier,
  }
}

export function tokenExchange(exchangeToken: string, verifier: string, spinner: Spinner): Promise<string> {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const res = await fetch(`${deployUrl}/auth/exchange`, {
        method: "POST",
        body: JSON.stringify({
          exchangeToken,
          verifier,
        }),
      });

      if (res.ok) {
        const { token, user } = await res.json();
        spinner.stop();
        console.log(
          `${
            green("✔")
          } Authorization successful. Authenticated as ${user.name}\n`,
        );
        clearInterval(interval);
        resolve(token);
      } else {
        const err = await res.json();
        if (
          !(err.code === "AUTHORIZATION_PENDING" &&
            err.message.endsWith(
              "The requested authorization has not been approved or denied yet.",
            ))
        ) {
          clearInterval(interval);
          reject(new Error(err.message));
        }
      }
    }, 2000);
  });
}

export async function withApp(
  trpcClient: TRPCClient<any>,
  org?: string,
  app?: string,
) {
  if (!org || !app) {
    const orgs: Array<{
      name: string;
      slug: string;
      id: string;
    }> = await trpcClient.orgs.list.query();

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

    const apps: Array<{ name: string; slug: string }> = await trpcClient.apps
      .list.query({
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

  return {
    org,
    app,
  };
}

