import { assertEquals } from "@std/assert";
import { applyGate, gcpApiEnableDecision } from "./setup-cloud.ts";

// The apply gate is the safety contract for `setup-aws` / `setup-gcp`: it must
// never resolve to "apply" in non-interactive mode unless the caller passed the
// explicit opt-in flag (`--apply` / `--enable-apis`).

Deno.test("applyGate: explicit opt-in always applies", () => {
  assertEquals(applyGate({ nonInteractive: true, optIn: true }), "apply");
  assertEquals(applyGate({ nonInteractive: false, optIn: true }), "apply");
});

Deno.test("applyGate: non-interactive without opt-in refuses (never auto-applies)", () => {
  assertEquals(applyGate({ nonInteractive: true, optIn: false }), "refuse");
});

Deno.test("applyGate: interactive without opt-in prompts the human", () => {
  assertEquals(applyGate({ nonInteractive: false, optIn: false }), "prompt");
});

// Enabling GCP APIs is the first cloud mutation, so it must be gated by the
// master `--apply` *before* the API-specific `--enable-apis`. Without `--apply`,
// non-interactive runs must refuse before anything is enabled — no partial
// mutation — regardless of whether `--enable-apis` was passed.

Deno.test("gcpApiEnableDecision: non-interactive without --apply refuses before mutating, even with --enable-apis", () => {
  assertEquals(
    gcpApiEnableDecision({
      nonInteractive: true,
      apply: false,
      enableApis: true,
    }),
    "refuse-apply",
  );
  assertEquals(
    gcpApiEnableDecision({
      nonInteractive: true,
      apply: false,
      enableApis: false,
    }),
    "refuse-apply",
  );
});

Deno.test("gcpApiEnableDecision: non-interactive with --apply still requires --enable-apis", () => {
  assertEquals(
    gcpApiEnableDecision({
      nonInteractive: true,
      apply: true,
      enableApis: false,
    }),
    "refuse-enable-apis",
  );
});

Deno.test("gcpApiEnableDecision: non-interactive enables only with both --apply and --enable-apis", () => {
  assertEquals(
    gcpApiEnableDecision({
      nonInteractive: true,
      apply: true,
      enableApis: true,
    }),
    "enable",
  );
});

Deno.test("gcpApiEnableDecision: interactive prompts unless --enable-apis pre-authorizes", () => {
  assertEquals(
    gcpApiEnableDecision({
      nonInteractive: false,
      apply: false,
      enableApis: false,
    }),
    "prompt",
  );
  assertEquals(
    gcpApiEnableDecision({
      nonInteractive: false,
      apply: false,
      enableApis: true,
    }),
    "enable",
  );
});
