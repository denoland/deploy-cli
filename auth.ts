import type { TRPCCombinedDataTransformer } from "@trpc/server";
import { serialize } from "superjson";
import open from "open";
import { encodeBase64 } from "@std/encoding";
import { green } from "@std/fmt/colors";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCClient,
} from "@trpc/client";
import { Spinner } from "@std/cli/unstable-spinner";
import { promptSelect } from "@std/cli/unstable-prompt-select";
import { parseArgs } from "@std/cli";
import { error } from "./util.ts";

const args = parseArgs(Deno.args, {
  string: ["endpoint"],
});

export const deployUrl = args.endpoint ?? "https://app.deno.com";

export function createTrpcClient(deployToken: string, github: string) {
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

  // deno-lint-ignore no-explicit-any
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
                cookie: `token=${deployToken}; deno_auth_ghid=${github}`,
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
  let githubUser = Deno.env.get("DEPLOY_GITHUB_USER");

  if (!deployToken) {
    const { code, exchangeToken, verifier } = await interactive();

    const authUrl = `${deployUrl}/auth?code=${code}`;

    console.log(`Visit ${authUrl} to authorize uploading of tarball.\x07`);
    const spinner = new Spinner({ message: "Waiting...", color: "yellow" });
    spinner.start();

    await open(authUrl);

    const exchange = await tokenExchange(exchangeToken, verifier, spinner);
    deployToken = exchange.token;
    githubUser = exchange.github;
  }

  return {
    token: deployToken!,
    github: githubUser!,
  };
}

export async function interactive(): Promise<
  { code: string; exchangeToken: string; verifier: string }
> {
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
  };
}

export function tokenExchange(
  exchangeToken: string,
  verifier: string,
  spinner: Spinner,
): Promise<{ token: string; github: string }> {
  return new Promise((resolve) => {
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
        resolve({ token, github: user.github_id });
      } else {
        const err = await res.json();
        if (
          !(err.code === "AUTHORIZATION_PENDING" &&
            err.message.endsWith(
              "The requested authorization has not been approved or denied yet.",
            ))
        ) {
          clearInterval(interval);
          spinner.stop();
          error(res, err.message);
        }
      }
    }, 2000);
  });
}

export async function withApp(
  // deno-lint-ignore no-explicit-any
  trpcClient: TRPCClient<any>,
  org?: string,
  app?: string | null,
): Promise< { org: string; app: string | null }> {
  if (!org || !app) {
    const orgs: Array<{
      name: string;
      slug: string;
      id: string;
      // deno-lint-ignore no-explicit-any
    }> = await (trpcClient.orgs as any).list.query();

    const orgStrings = orgs.map((org) => `${org.name} (${org.slug})`);
    const orgsResult = promptSelect("Select an organization:", orgStrings, {
      clear: true,
    });
    if (!orgsResult) {
      console.error("No organization was selected.");
      Deno.exit(1);
    }

    const selectedOrg = orgs[orgStrings.indexOf(orgsResult)];
    org = selectedOrg.slug;
    console.log(`Selected organization '${selectedOrg.name}'`);

    const apps: Array<{ name: string; slug: string }> =
      // deno-lint-ignore no-explicit-any
      await (trpcClient.apps as any)
        .list.query({
          org: selectedOrg.id,
        });
    const appStrings = apps.map((app) => `${app.slug}`);
    appStrings.push("Create a new app");
    const appsResult = promptSelect("Select an application:", appStrings, {
      clear: true,
    });
    if (!appsResult) {
      console.error("No application was selected.");
      Deno.exit(1);
    }

    const index = appStrings.indexOf(appsResult);

    if (index == (appStrings.length - 1)) {
      app = null;
    } else {
      const selectedApp = apps[appStrings.indexOf(appsResult)];
      app = selectedApp.slug;
      console.log(`Selected app '${selectedApp.slug}'`);
    }
  }

  if (org === undefined) {
    console.error(
      "Expected 'deploy.org' in the config file or the '--org' flag to be specified.",
    );
    Deno.exit(1);
  }
  if (app === undefined) {
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
