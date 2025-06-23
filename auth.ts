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
} from "@trpc/client";
import { Spinner } from "@std/cli/unstable-spinner";
import { error } from "./util.ts";
import token_storage, { type Authorization } from "./token_storage.ts";

export async function createTrpcClient(deployUrl: string) {
  const storedAuth = await token_storage.get();

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
            if (storedAuth) {
              return {
                cookie:
                  `token=${storedAuth.token}; deno_auth_ghid=${storedAuth.githubUser}`,
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

export async function getAuth(deployUrl: string): Promise<Authorization> {
  const storedAuth = await token_storage.get();
  if (storedAuth) {
    return storedAuth;
  }

  const { code, exchangeToken, verifier } = await interactive(deployUrl);

  const authUrl = `${deployUrl}/auth?code=${code}`;

  console.log(`Visit ${authUrl} to authorize deploying your project.\x07`);
  const spinner = new Spinner({ message: "Waiting...", color: "yellow" });
  spinner.start();

  await open(authUrl);

  return await tokenExchange(deployUrl, exchangeToken, verifier, spinner);
}

export async function interactive(deployUrl: string): Promise<
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
  deployUrl: string,
  exchangeToken: string,
  verifier: string,
  spinner: Spinner,
): Promise<Authorization> {
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
        const auth = { token, githubUser: user.github_id };
        await token_storage.store(auth);
        resolve(auth);
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
          error(err.message, res);
        }
      }
    }, 2000);
  });
}

export async function authedFetch(
  deployUrl: string,
  endpoint: string,
  init: RequestInit,
) {
  let auth = await token_storage.get();

  if (!auth) {
    auth = await getAuth(deployUrl);
    await token_storage.store(auth);
  }

  const headers = new Headers(init.headers);
  headers.set(
    "cookie",
    `token=${auth.token}; deno_auth_ghid=${auth.githubUser}`,
  );
  const authedInit = {
    ...init,
    headers,
  };

  const url = deployUrl + endpoint;
  const res = await fetch(url, authedInit);

  if (res.status === 401) {
    auth = await getAuth(deployUrl);
    await token_storage.store(auth);

    const res = await fetch(url, authedInit);

    if (res.status === 401) {
      const err = await res.json();
      error(`unexpected authentication failure\n${err.message}`);
    } else {
      return res;
    }
  } else {
    return res;
  }
}
