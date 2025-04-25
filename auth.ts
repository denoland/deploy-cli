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

export const deployUrl = Deno.env.get("DEPLOY_URL");
export let deployToken = Deno.env.get("DEPLOY_TOKEN");

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
export const trpcClient = createTRPCClient<any>({
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

if (!deployUrl) {
  console.error(
    "Expected the 'DEPLOY_URL' environmental variable to be specified.",
  );
  Deno.exit(1);
}
if (!deployToken) {
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

  const authUrl = `${deployUrl}/auth?code=${body.code}`;

  console.log(`Visit ${authUrl} to authorize uploading of tarball.\x07`);
  const spinner = new Spinner({ message: "Waiting...", color: "yellow" });
  spinner.start();

  await open(authUrl);

  deployToken = await new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const res = await fetch(`${deployUrl}/auth/exchange`, {
        method: "POST",
        body: JSON.stringify({
          exchangeToken: body.exchangeToken,
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
            err.message.endsWith("The requested authorization has not been approved or denied yet."))
        ) {
          clearInterval(interval);
          reject(new Error(err.message));
        }
      }
    }, 2000);
  });
}
