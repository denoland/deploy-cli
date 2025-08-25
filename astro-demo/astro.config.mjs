// @ts-check
import { defineConfig } from "astro/config";
import deno from "@deno/astro-adapter";

// https://astro.build/config
export default defineConfig({
  output: "server",
  server: {
    allowedHosts: ["deploy-subcommand-testing--local.deno.deno.net"],
  },
  adapter: deno(),
});
