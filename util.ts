import { red } from "@std/fmt/colors";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { Temporal } from "temporal-polyfill";

import { createTrpcClient, getAuth } from "./auth.ts";

export function error(
  debug: boolean,
  error: string,
  response?: Response,
): never {
  console.error();
  console.error(`${red("✗")} An error occurred:`);
  console.error(`  ${error.replaceAll("\n", "\n  ")}`);
  const trace = response?.headers.get("x-deno-trace-id");
  if (debug) {
    console.error(`  stack:\n${new Error().stack}`);
  }
  if (trace) {
    console.error(`  trace id: ${trace}`);
  }
  Deno.exit(1);
}

/**
 * Ensure app and org are selected
 *
 * If app is specified as null, it will not be selected and returned as null.
 *
 * @param debug
 * @param deployUrl
 * @param canCreate
 * @param org
 * @param app
 * @param quiet
 */
export async function withApp(
  debug: boolean,
  deployUrl: string,
  canCreate: false,
  org?: string,
  app?: string | null,
  quiet?: boolean,
): Promise<{ org: string; app: string }>;
export async function withApp(
  debug: boolean,
  deployUrl: string,
  canCreate: true,
  org?: string,
  app?: string | null,
  quiet?: boolean,
): Promise<{ org: string; app: string | null }>;
export async function withApp(
  debug: boolean,
  deployUrl: string,
  canCreate: boolean,
  org?: string,
  app?: string | null,
  quiet?: boolean,
): Promise<{ org: string; app: string | null }> {
  await getAuth(debug, deployUrl, quiet);

  if (!org) {
    org = Deno.env.get("DENO_DEPLOY_ORG");
  }
  if (app === undefined) {
    app = Deno.env.get("DENO_DEPLOY_APP");
  }

  if (org === undefined || app === undefined) {
    const trpcClient = createTrpcClient(debug, deployUrl);

    let fullOrg;
    const orgs: Array<{
      name: string;
      slug: string;
      id: string;
      // deno-lint-ignore no-explicit-any
    }> = await (trpcClient.orgs as any).list.query();

    if (org !== undefined) {
      fullOrg = orgs.find((fullOrg) => fullOrg.slug === org);
      if (!fullOrg) {
        error(debug, `Organization '${org}' does not exist.`);
      }
    } else if (orgs.length === 1) {
      fullOrg = orgs[0];
      org = orgs[0].slug;
    } else {
      const selectedOrg = promptSelect(
        "Select an organization:",
        orgs.map((org) => ({ label: `${org.name} (${org.slug})`, value: org })),
        {
          clear: true,
        },
      );
      if (!selectedOrg) {
        error(debug, "No organization was selected.");
      }

      fullOrg = selectedOrg.value;
      org = selectedOrg.value.slug;
      console.log(`Selected organization '${selectedOrg.value.name}'`);
    }

    if (app === null) {
      return {
        org,
        app: null,
      };
    }

    const apps: Array<{ name: string; slug: string }> =
      // deno-lint-ignore no-explicit-any
      await (trpcClient.apps as any)
        .list.query({
          org: fullOrg.id,
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

export const KIBIBYTE = 1024;
export const MEBIBYTE = KIBIBYTE * 1024;
export const GIBIBYTE = MEBIBYTE * 1024;

export const KILOBYTE = 1000;
export const MEGABYTE = KILOBYTE * 1000;
export const GIGABYTE = MEGABYTE * 1000;

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  if (bytes >= GIBIBYTE) {
    return `${parseFloat((bytes / GIBIBYTE).toFixed(2))} GiB`;
  }

  if (bytes >= MEBIBYTE) {
    return `${parseFloat((bytes / MEBIBYTE).toFixed(2))} MiB`;
  }

  if (bytes >= KIBIBYTE) {
    return `${parseFloat((bytes / KIBIBYTE).toFixed(2))} KiB`;
  }

  return `${bytes} Bytes`;
}

export function parseSize(size: string | undefined): number | undefined {
  if (size === undefined) return undefined;

  const match = size.match(/^(\d+)(GB|MB|KB|GiB|MiB|KiB)$/i);
  if (!match) {
    error(
      false,
      "Invalid size format. Examples of valid size: '2gb', '1024mb'",
    );
  }
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  switch (unit.toLowerCase()) {
    case "gb":
      return num * GIGABYTE;
    case "mb":
      return num * MEGABYTE;
    case "kb":
      return num * KILOBYTE;
    case "gib":
      return num * GIBIBYTE;
    case "mib":
      return num * MEBIBYTE;
    case "kib":
      return num * KIBIBYTE;
  }
}

export function tablePrinter<T>(
  headers: string[],
  values: T[],
  transformer: (value: T) => string[],
) {
  const padding = headers.map((header) => header.length);

  const processed = values.map((value) => {
    const transformed = transformer(value);

    for (let i = 0; i < transformed.length; i++) {
      padding[i] = Math.max(padding[i], transformed[i].length);
    }

    return transformed;
  });

  console.log(
    headers.map((header, i) => header.padEnd(padding[i])).join("   "),
  );

  for (const row of processed) {
    console.log(row.map((field, i) => field.padEnd(padding[i])).join("   "));
  }
}
