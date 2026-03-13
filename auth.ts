import type { TRPCCombinedDataTransformer } from "@trpc/server";
import { serialize } from "superjson";
import open from "open";
import { encodeBase64 } from "@std/encoding";
import { green } from "@std/fmt/colors";
import {
  createTRPCUntypedClient,
  httpBatchStreamLink,
  httpSubscriptionLink,
  retryLink,
  splitLink,
  TRPCClientError,
  type TRPCLink,
  type TRPCUntypedClient,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { Spinner } from "@std/cli/unstable-spinner";
import { error, isInteractive } from "./util.ts";
import { EventSourcePolyfill } from "event-source-polyfill";
import type { GlobalContext } from "./main.ts";

// deno-lint-ignore no-explicit-any
export type TRPCClient = TRPCUntypedClient<any>;

export function createTrpcClient(
  context: GlobalContext,
  quiet: boolean = false,
) {
  let storedAuth = tokenStorage.get();

  // deno-lint-ignore no-explicit-any
  const errorLink: TRPCLink<any> = () => {
    return ({ next, op }) => {
      return observable((observer) => {
        return next(op).subscribe({
          next(value) {
            observer.next(value);
          },
          error(err) {
            if (context.debug) {
              console.error(err);
            }
            error(
              context,
              err.message || Deno.inspect(err),
              err.meta?.response as Response | undefined,
            );
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

  return createTRPCUntypedClient({
    links: [
      errorLink,
      retryLink({
        retry(opts) {
          if (context.debug) {
            console.log(opts);
          }

          if (
            opts.error?.data?.httpStatus && opts.error.data.httpStatus !== 401
          ) {
            return false;
          }

          if (tokenIsTemp) {
            error(
              context,
              "The token specified via 'DENO_DEPLOY_TOKEN' or the '--token' flag is invalid.",
            );
          }

          if (typeof retryPromise !== "undefined") {
            tokenStorage.remove();
            error(
              context,
              "Already re-attempted authorization, please re-run this command",
            );
          }

          tokenStorage.remove();
          retryPromise = getAuth(context, quiet).then((auth) => {
            storedAuth = auth;
          });
          return true;
        },
      }),
      splitLink({
        // uses the httpSubscriptionLink for subscriptions
        condition: (op) => op.type === "subscription",
        false: httpBatchStreamLink({
          url: context.endpoint + "/api",
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
          url: context.endpoint + "/api",
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
  context: GlobalContext,
  quiet: boolean = false,
): Promise<string> {
  const storedAuth = tokenStorage.get();
  if (storedAuth) {
    return storedAuth;
  }

  if (!isInteractive()) {
    error(
      context,
      "Authentication required but stdin is not a terminal.\nSet the DENO_DEPLOY_TOKEN environment variable or use --token.",
    );
  }

  const { code, exchangeToken, verifier } = await interactive(context);

  const authUrl = `${context.endpoint}/auth?code=${code}`;

  const spinner = new Spinner({
    message: `Visit ${authUrl} to authorize deploying your project.`,
    color: "yellow",
  });
  if (!quiet) spinner.start();

  await open(authUrl);

  return await tokenExchange(
    context,
    exchangeToken,
    verifier,
    spinner,
    quiet,
  );
}

export async function interactive(context: GlobalContext): Promise<
  { code: string; exchangeToken: string; verifier: string }
> {
  const verifier = crypto.randomUUID();
  const data = (new TextEncoder()).encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = encodeBase64(hash);

  const res = await fetch(`${context.endpoint}/auth/interactive`, {
    method: "POST",
    body: JSON.stringify({ challenge }),
  });

  if (!res.ok) {
    error(
      context,
      "An error occurred during authentication, exiting...",
      res,
    );
  }

  const body = await res.json();

  return {
    code: body.code,
    exchangeToken: body.exchangeToken,
    verifier,
  };
}

export function tokenExchange(
  context: GlobalContext,
  exchangeToken: string,
  verifier: string,
  spinner: Spinner,
  quiet: boolean,
): Promise<string> {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      const res = await fetch(`${context.endpoint}/auth/exchange`, {
        method: "POST",
        body: JSON.stringify({
          exchangeToken,
          verifier,
        }),
      });

      if (res.ok) {
        const { token, user } = await res.json();
        spinner.stop();
        if (!quiet) {
          console.log(
            `${
              green("✔")
            } Authorization successful. Authenticated as ${user.name}\n`,
          );
        }
        clearInterval(interval);
        tokenStorage.set(token);
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
          error(context, err.message, res);
        }
      }
    }, 2000);
  });
}

export async function authedFetch(
  context: GlobalContext,
  endpoint: string,
  init: RequestInit,
) {
  let auth = tokenStorage.get();

  if (!auth) {
    auth = await getAuth(context);
  }

  const headers = new Headers(init.headers);
  headers.set(
    "cookie",
    `token=${auth}; deno_auth_ghid=force`,
  );

  const url = new URL(endpoint, context.endpoint);

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
    tokenStorage.remove();
    auth = await getAuth(context);

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
      error(context, `unexpected authentication failure\n${err.message}`);
    } else {
      return retryRes;
    }
  } else {
    return res;
  }
}

let cachedToken: string | null = null;
export let tokenIsTemp = false;
let cannotInteractWithKeychain = false;

const KEYCHAIN_WARNING =
  "Unable to interact with keychain.\nThe authentication will not be stored and will only work on this execution.";

export const tokenStorage = {
  get(): string | null {
    if (cachedToken) {
      return cachedToken;
    } else {
      try {
        // @ts-ignore deno internals
        return Deno[Deno.internal].core.ops.op_deploy_token_get();
      } catch {
        if (!cannotInteractWithKeychain) {
          cannotInteractWithKeychain = true;
          console.log(KEYCHAIN_WARNING);
        }
        return null;
      }
    }
  },
  set(token: string, temp: boolean = false) {
    cachedToken = token;
    if (!temp) {
      try {
        // @ts-ignore deno internals
        Deno[Deno.internal].core.ops.op_deploy_token_set(token);
      } catch {
        if (!cannotInteractWithKeychain) {
          cannotInteractWithKeychain = true;
          console.log(KEYCHAIN_WARNING);
        }
      }
    } else {
      tokenIsTemp = temp;
    }
  },
  remove() {
    if (tokenIsTemp) {
      return;
    }
    cachedToken = null;
    try {
      // @ts-ignore deno internals
      Deno[Deno.internal].core.ops.op_deploy_token_delete();
    } catch {
      if (!cannotInteractWithKeychain) {
        cannotInteractWithKeychain = true;
        console.log(KEYCHAIN_WARNING);
      }
    }
  },
};
