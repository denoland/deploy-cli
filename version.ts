import denoJson from "./deno.json" with { type: "json" };

export const VERSION = (denoJson as { version?: string }).version ??
  "0.0.0-dev";
