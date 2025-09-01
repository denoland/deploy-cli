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
  TRPCClientError,
  type TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { Spinner } from "@std/cli/unstable-spinner";
import { error } from "./util.ts";
import token_storage, { tokenIsTemp } from "./token_storage.ts";
import { EventSourcePolyfill } from "event-source-polyfill";

export function createTrpcClient(debug: boolean, deployUrl: string) {
  let storedAuth = token_storage.get();

  // deno-lint-ignore no-explicit-any
  const errorLink: TRPCLink<any> = () => {
    return ({ next, op }) => {
      return observable((observer) => {
        return next(op).subscribe({
          next(value) {
            observer.next(value);
          },
          error(err) {
            if (debug) {
              console.error(err);
            }
            error(debug, err.message || Deno.inspect(err));
          },
          complete() {
            observer.complete();
          },
        });
      });
    };
  };

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
      errorLink,
      retryLink({
        retry({ error: err }) {
          if (
            !(err?.data?.code !== "NOT_AUTHENTICATED" &&
              err?.data?.code !== "TOKEN_EXPIRED")
          ) {
            return false;
          }

          if (tokenIsTemp) {
            error(
              debug,
              "The token specified via 'DENO_DEPLOY_TOKEN' is invalid.",
            );
          }

          if (typeof retryPromise !== "undefined") {
            token_storage.remove();
            error(
              debug,
              "Already re-attempted authorization, please re-run this command",
            );
          }

          token_storage.remove();
          retryPromise = getAuth(debug, deployUrl).then((auth) => {
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
          fetch: async (url, options) => {
            // deno-lint-ignore no-explicit-any
            const response = await fetch(url, options as any);
            if (response.status === 401) {
              throw TRPCClientError.from({
                message: "Unauthorized",
                code: -32004,
                data: { httpStatus: 401, code: "NOT_AUTHENTICATED" },
              });
            } else if (response.status === 403) {
              const body = await response.clone().json();
              console.log(body);
              if (body.code === "TOKEN_EXPIRED") {
                throw TRPCClientError.from({
                  message: "Token Expired",
                  code: -32004,
                  data: { httpStatus: 401, code: "TOKEN_EXPIRED" },
                });
              }
            }
            return response;
          },
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

export async function getAuth(
  debug: boolean,
  deployUrl: string,
): Promise<string> {
  const storedAuth = token_storage.get();
  if (storedAuth) {
    return storedAuth;
  }

  const { code, exchangeToken, verifier } = await interactive(debug, deployUrl);

  const authUrl = `${deployUrl}/auth?code=${code}`;

  console.log(`Visit ${authUrl} to authorize deploying your project.\x07`);
  const spinner = new Spinner({ message: "Waiting...", color: "yellow" });
  spinner.start();

  await open(authUrl);

  return await tokenExchange(
    debug,
    deployUrl,
    exchangeToken,
    verifier,
    spinner,
  );
}

export async function interactive(debug: boolean, deployUrl: string): Promise<
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
    console.error("An error occurred during authentication, exiting...");
    if (debug) {
      console.log(res);
      console.log(await res.json());
    }
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
  debug: boolean,
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
          error(debug, err.message, res);
        }
      }
    }, 2000);
  });
}

export async function authedFetch(
  debug: boolean,
  deployUrl: string,
  endpoint: string,
  init: RequestInit,
) {
  let auth = await token_storage.get();

  if (!auth) {
    auth = await getAuth(debug, deployUrl);
  }

  const headers = new Headers(init.headers);
  headers.set(
    "cookie",
    `token=${auth}; deno_auth_ghid=force`,
  );

  const url = new URL(endpoint, deployUrl);

  let fallbackBody: ReadableStream | undefined;
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
    console.log(await res.text());
    token_storage.remove();
    auth = await getAuth(debug, deployUrl);

    const headers = new Headers(init.headers);
    headers.set(
      "cookie",
      `token=${auth}; deno_auth_ghid=force`,
    );
    const retryRes = await fetch(url, {
      ...init,
      headers,
      body: init.body instanceof ReadableStream ? fallbackBody : init.body,
    });

    if (retryRes.status === 401) {
      const err = await retryRes.json();
      error(debug, `unexpected authentication failure\n${err.message}`);
    } else {
      return retryRes;
    }
  } else {
    return res;
  }
}
