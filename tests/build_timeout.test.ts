import { assertEquals } from "@std/assert";
import type { TRPCClient } from "../auth.ts";
import {
  detectedBuildTimeout,
  detectedBuildTimeoutForOrg,
} from "../deploy/create/flow.ts";

Deno.test("detectedBuildTimeout: undefined without a deno.json build timeout", () => {
  assertEquals(detectedBuildTimeout(null), undefined);
  assertEquals(detectedBuildTimeout({ frameworkPreset: "fresh" }), undefined);
});

Deno.test("detectedBuildTimeout: snaps to an available step", () => {
  const timeout = (buildTimeout: number) =>
    detectedBuildTimeout({ frameworkPreset: "fresh", buildTimeout });
  assertEquals(timeout(20), 20);
  assertEquals(timeout(12), 10);
  assertEquals(timeout(60), 30);
  assertEquals(timeout(1), 5);
});

Deno.test("detectedBuildTimeout: caps to the plan maximum", () => {
  const config = { frameworkPreset: "fresh" as const, buildTimeout: 20 };
  assertEquals(detectedBuildTimeout(config, 5), 5);
  assertEquals(detectedBuildTimeout(config, 30), 20);
});

function fakeOrgsClient(maxBuildTimeout: number) {
  const queries: string[] = [];
  const client = {
    query(path: string) {
      queries.push(path);
      return Promise.resolve([
        {
          id: "org-id",
          slug: "acme",
          subscription_metadata: { max_build_timeout: maxBuildTimeout },
        },
      ]);
    },
  } as unknown as TRPCClient;
  return { client, queries };
}

Deno.test("detectedBuildTimeoutForOrg: does not query at or below the minimum", async () => {
  const { client, queries } = fakeOrgsClient(5);
  assertEquals(
    await detectedBuildTimeoutForOrg(client, "acme", null),
    undefined,
  );
  assertEquals(
    await detectedBuildTimeoutForOrg(client, "acme", {
      frameworkPreset: "fresh",
      buildTimeout: 5,
    }),
    5,
  );
  assertEquals(queries, []);
});

Deno.test("detectedBuildTimeoutForOrg: caps to the org's plan, matched by slug or id", async () => {
  const config = { frameworkPreset: "fresh" as const, buildTimeout: 20 };
  const free = fakeOrgsClient(5);
  assertEquals(
    await detectedBuildTimeoutForOrg(free.client, "acme", config),
    5,
  );
  assertEquals(
    await detectedBuildTimeoutForOrg(free.client, "org-id", config),
    5,
  );
  assertEquals(free.queries, ["orgs.list", "orgs.list"]);
  const pro = fakeOrgsClient(30);
  assertEquals(
    await detectedBuildTimeoutForOrg(pro.client, "acme", config),
    20,
  );
});

Deno.test("detectedBuildTimeoutForOrg: leaves an unknown org uncapped for the console to judge", async () => {
  const { client } = fakeOrgsClient(5);
  assertEquals(
    await detectedBuildTimeoutForOrg(client, "other", {
      frameworkPreset: "fresh",
      buildTimeout: 20,
    }),
    20,
  );
});
