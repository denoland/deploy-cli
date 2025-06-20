import { red } from "@std/fmt/colors";

export function error(response: Response, error: string): never {
  console.error(`${red("✗")} An error occurred:`);
  console.error(`  ${error}`);
  if (response.headers.has("x-deno-trace-id")) {
    console.error(`  trace id: ${response.headers.get("x-deno-trace-id")}`);
  }
  Deno.exit(1);
}