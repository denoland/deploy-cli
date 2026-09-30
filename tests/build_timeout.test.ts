import { assertEquals } from "@std/assert";
import { detectedBuildTimeout } from "../deploy/create/flow.ts";

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
