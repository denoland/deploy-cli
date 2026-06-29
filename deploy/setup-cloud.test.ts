import { assertEquals } from "@std/assert";
import { applyGate } from "./setup-cloud.ts";

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
