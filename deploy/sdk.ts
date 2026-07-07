import type { Client as SdkClient } from "@deno/sandbox";
import { getAuth } from "../auth.ts";
import { sandboxApi } from "../sandbox/api.ts";
import type { GlobalContext } from "../main.ts";

/**
 * Constructs a typed `@deno/sandbox` {@linkcode SdkClient} for talking to the
 * public `/api/v2` REST API (revision progress, timelines).
 *
 * `@deno/sandbox` is loaded through {@linkcode sandboxApi} so it stays out of
 * the CLI's eager module graph (see `sandbox/api.ts` for why). The named type
 * import above is erased at runtime and is therefore safe.
 *
 * `org` must be the organization **slug**: `/api/v2` accepts the CLI's
 * user/device token as a Bearer token only when it is paired with an
 * `X-Deno-Org` header, which the SDK client sends when constructed with `org`.
 */
export async function deploySdkClient(
  context: GlobalContext,
  org: string,
): Promise<SdkClient> {
  // Resolve (and, if needed, interactively obtain) a valid token up front: the
  // SDK client has no token-refresh path and would otherwise throw a bare 401
  // if the stored token were missing or expired.
  const token = await getAuth(context);
  const { Client } = await sandboxApi();
  return new Client({ token, org, apiEndpoint: context.endpoint });
}
