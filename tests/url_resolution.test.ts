import { assertEquals } from "@std/assert";

// Reproduces the URL resolution behavior in authedFetch.
// Before the fix: new URL(endpoint, base) drops path segments from the base.
// After the fix: string concatenation preserves the full base path.

Deno.test("new URL() two-arg drops base path segments", () => {
  // This is the OLD (broken) behavior that motivates the fix.
  // When the endpoint is a proxy URL with a path, the path-based
  // target host segment gets silently dropped.
  const base = "https://proxy.example.com/target-host";
  const endpoint = "api/diffsync/org/app/rev123";

  const broken = new URL(endpoint, base);
  // new URL resolves relative to the parent of "target-host", losing it:
  assertEquals(broken.pathname, "/api/diffsync/org/app/rev123");
  // "target-host" is gone — the proxy can no longer route the request.
});

Deno.test("string concatenation preserves base path segments", () => {
  // This is the FIXED behavior: concatenation keeps the full base path.
  const base = "https://proxy.example.com/target-host";
  const endpoint = "api/diffsync/org/app/rev123";

  const fixed = new URL(`${base}/${endpoint}`);
  assertEquals(
    fixed.pathname,
    "/target-host/api/diffsync/org/app/rev123",
  );
});

Deno.test("string concatenation works for standard endpoint too", () => {
  // Ensure the fix doesn't regress the normal (non-proxy) case.
  const base = "https://console.deno.com";
  const endpoint = "api/diffsync/org/app/rev123";

  const fixed = new URL(`${base}/${endpoint}`);
  assertEquals(fixed.pathname, "/api/diffsync/org/app/rev123");
  assertEquals(fixed.hostname, "console.deno.com");
});
