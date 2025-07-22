import { red } from "@std/fmt/colors";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { Temporal } from "temporal-polyfill";

import { createTrpcClient, getAuth } from "./auth.ts";

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
  await getAuth(deployUrl);

  if (!org || !app) {
    const trpcClient = createTrpcClient(deployUrl);

    const orgs: Array<{
      name: string;
      slug: string;
      id: string;
      // deno-lint-ignore no-explicit-any
    }> = await (trpcClient.orgs as any).list.query();

    const selectedOrg = promptSelect(
      "Select an organization:",
      orgs.map((org) => ({ label: `${org.name} (${org.slug})`, value: org })),
      {
        clear: true,
      },
    );
    if (!selectedOrg) {
      console.error("No organization was selected.");
      Deno.exit(1);
    }

    org = selectedOrg.value.slug;
    console.log(`Selected organization '${selectedOrg.value.name}'`);

    const apps: Array<{ name: string; slug: string }> =
      // deno-lint-ignore no-explicit-any
      await (trpcClient.apps as any)
        .list.query({
          org: selectedOrg.value.id,
        });
    const appStrings: PromptEntry<{ name: string; slug: string } | null>[] =
      apps.map((app) => ({ label: app.slug, value: app }));
    if (canCreate) {
      appStrings.unshift({ label: "Create a new application", value: null });
    }
    const selectedApp = promptSelect("Select an application:", appStrings, {
      clear: true,
    });
    if (!selectedApp) {
      console.error("No application was selected.");
      Deno.exit(1);
    }

    if (selectedApp.value === null) {
      app = null;
    } else {
      app = selectedApp.value.slug;
      console.log(`Selected application '${selectedApp.value.slug}'`);
    }
  }

  return {
    org,
    app,
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
