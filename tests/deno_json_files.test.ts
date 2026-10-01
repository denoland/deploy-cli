import { assertEquals } from "@std/assert";
import { isDenoJson } from "../deploy/publish.ts";

Deno.test("isDenoJson: matches deno.json and deno.jsonc at any depth", () => {
  assertEquals(isDenoJson("deno.json"), true);
  assertEquals(isDenoJson("deno.jsonc"), true);
  assertEquals(isDenoJson("apps/web/deno.json"), true);
  assertEquals(isDenoJson("package.json"), false);
  assertEquals(isDenoJson("deno.json.bak"), false);
  assertEquals(isDenoJson("src/mydeno.json"), false);
});
