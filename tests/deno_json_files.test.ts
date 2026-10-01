import { assertEquals } from "@std/assert";
import { normalizeBuildDirectory } from "../deploy/publish.ts";

Deno.test("normalizeBuildDirectory: matches the console's normalization", () => {
  assertEquals(normalizeBuildDirectory(""), "");
  assertEquals(normalizeBuildDirectory("."), "");
  assertEquals(normalizeBuildDirectory("apps/web"), "apps/web");
  assertEquals(normalizeBuildDirectory("./apps/web/"), "apps/web");
  assertEquals(normalizeBuildDirectory("apps\\web"), "apps/web");
  assertEquals(normalizeBuildDirectory("..app"), "..app");
  assertEquals(normalizeBuildDirectory("../private"), "");
  assertEquals(normalizeBuildDirectory("apps/../.."), "");
  assertEquals(normalizeBuildDirectory("..\\private"), "");
});
