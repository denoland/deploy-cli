import type { TRPCCombinedDataTransformer } from "@trpc/server";
import { serialize } from "superjson";
import open from "open";
import { encodeBase64 } from "@std/encoding";
import { green } from "@std/fmt/colors";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpSubscriptionLink,
  retryLink,
  splitLink,
} from "@trpc/client";
import { Spinner } from "@std/cli/unstable-spinner";
import { error } from "./util.ts";
import token_storage from "./token_storage.ts";
import { EventSourcePolyfill } from "event-source-polyfill";

export function createTrpcClient(deployUrl: string) {
  let storedAuth = token_storage.get();

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

  let retryPromise: Promise<void> | undefined = undefined;

  // deno-lint-ignore no-explicit-any
  return createTRPCClient<any>({
    links: [
      retryLink({
        retry() {
          // TODO: check its an auth error

          if (typeof retryPromise !== "undefined") {
            return false;
          }

          token_storage.remove();
          retryPromise = getAuth(deployUrl).then((auth) => {
            storedAuth = auth;
          });
          return true;
        },
      }),
      splitLink({
        // uses the httpSubscriptionLink for subscriptions
        condition: (op) => op.type === "subscription",
        false: httpBatchStreamLink({
          url: deployUrl + "/api",
          async headers() {
            if (retryPromise) {
              await retryPromise;
              retryPromise = undefined;
            }

            if (storedAuth) {
              return {
                cookie: `token=${storedAuth}; deno_auth_ghid=force`,
              };
            } else {
              return {};
            }
          },
          transformer,
        }),
        true: httpSubscriptionLink({
          url: deployUrl + "/api",
          EventSource: EventSourcePolyfill,
          async eventSourceOptions() {
            if (retryPromise) {
              await retryPromise;
              retryPromise = undefined;
            }

            if (storedAuth) {
              return {
                headers: {
                  cookie: `token=${storedAuth}; deno_auth_ghid=force`,
                },
              };
            } else {
              return {};
            }
          },
          transformer,
        }),
      }),
    ],
  });
}

export async function getAuth(deployUrl: string): Promise<string> {
  const storedAuth = token_storage.get();
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

  console.log(`${deployUrl}/auth/interactive`);

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
): Promise<string> {
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
        token_storage.set(token);
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
  }

  const headers = new Headers(init.headers);
  headers.set(
    "cookie",
    `token=${auth}; deno_auth_ghid=force`,
  );

  const url = new URL(endpoint, deployUrl);

  let fallbackBody: ReadableStream | undefined;
  try {
    if (init.body instanceof ReadableStream) {
      const [a, b] = init.body.tee();
      init.body = a;
      fallbackBody = b;
    }

    const res = await fetch(url, {
      ...init,
      headers,
    });

    if (res.status === 401) {
      token_storage.remove();
      auth = await getAuth(deployUrl);

      const headers = new Headers(init.headers);
      headers.set(
        "cookie",
        `token=${auth}; deno_auth_ghid=force`,
      );
      const res = await fetch(url, {
        ...init,
        headers,
      });

      if (res.status === 401) {
        const err = await res.json();
        error(`unexpected authentication failure\n${err.message}`);
      } else {
        return res;
      }
    } else {
      return res;
    }
  } catch {
    token_storage.remove();
    auth = await getAuth(deployUrl);

    const headers = new Headers(init.headers);
    headers.set(
      "cookie",
      `token=${auth}; deno_auth_ghid=force`,
    );
    const res = await fetch(url, {
      ...init,
      headers,
      body: init.body instanceof ReadableStream ? fallbackBody : init.body,
    });

    if (res.status === 401) {
      const err = await res.json();
      error(`unexpected authentication failure\n${err.message}`);
    } else {
      return res;
    }
  }
}
