import { red } from "@std/fmt/colors";
import { promptSelect } from "@std/cli/unstable-prompt-select";
import { Temporal } from "temporal-polyfill";

import { createTrpcClient, getAuth } from "./auth.ts";
import token_storage from "./token_storage.ts";

export function error(error: string, response?: Response): never {
  console.error(`${red("✗")} An error occurred:`);
  console.error(`  ${error.replaceAll("\n", "\n  ")}`);
  const trace = response?.headers.get("x-deno-trace-id");
  if (trace) {
    console.error(`  trace id: ${trace}`);
  }
  Deno.exit(1);
}

export async function withApp(
  deployUrl: string,
  canCreate: false,
  org?: string,
  app?: string | null,
): Promise<{ org: string; app: string }>;
export async function withApp(
  deployUrl: string,
  canCreate: true,
  org?: string,
  app?: string | null,
): Promise<{ org: string; app: string | null }>;
export async function withApp(
  deployUrl: string,
  canCreate: boolean,
  org?: string,
  app?: string | null,
): Promise<{ org: string; app: string | null }> {
  async function inner() {
    await getAuth(deployUrl);

    if (!org || !app) {
      const trpcClient = createTrpcClient(deployUrl);

      const orgs: Array<{
        name: string;
        slug: string;
        id: string;
        // deno-lint-ignore no-explicit-any
      }> = await (trpcClient.orgs as any).list.query();

      const orgStrings = orgs.map((org) => `${org.name} (${org.slug})`);
      const orgsResult = promptSelect("Select an organization:", orgStrings, {
        clear: true,
      });
      if (!orgsResult) {
        console.error("No organization was selected.");
        Deno.exit(1);
      }

      const selectedOrg = orgs[orgStrings.indexOf(orgsResult)];
      org = selectedOrg.slug;
      console.log(`Selected organization '${selectedOrg.name}'`);

      const apps: Array<{ name: string; slug: string }> =
        // deno-lint-ignore no-explicit-any
        await (trpcClient.apps as any)
          .list.query({
            org: selectedOrg.id,
          });
      const appStrings = apps.map((app) => `${app.slug}`);
      if (canCreate) {
        appStrings.push("Create a new application");
      }
      const appsResult = promptSelect("Select an application:", appStrings, {
        clear: true,
      });
      if (!appsResult) {
        console.error("No application was selected.");
        Deno.exit(1);
      }

      const index = appStrings.indexOf(appsResult);

      if (canCreate && index == (appStrings.length - 1)) {
        app = null;
      } else {
        const selectedApp = apps[appStrings.indexOf(appsResult)];
        app = selectedApp.slug;
        console.log(`Selected application '${selectedApp.slug}'`);
      }
    }
  }

  try {
    await inner();
  } catch {
    token_storage.remove();

    await inner();
  }

  return {
    org: org as string,
    app: app as string | null,
  };
}

export function renderTemporalTimestamp(timestamp: string, hideDate = false) {
  function pad(n: number, width: number): string {
    return n.toString().padStart(width, "0");
  }

  const date = Temporal
    .Instant
    .from(timestamp)
    .toZonedDateTimeISO("UTC");
  const months = pad(date.month, 2);
  const days = pad(date.day, 2);
  const hours = pad(date.hour, 2);
  const minutes = pad(date.minute, 2);
  const seconds = pad(date.second, 2);
  const ms = (date.millisecond / 1000).toFixed(2).substring(2);

  const time = `${hours}:${minutes}:${seconds}.${ms}`;
  if (hideDate) return time;

  return `${date.year}-${months}-${days} ${time}`;
}
