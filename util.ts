import { green, red, stripAnsiCode } from "@std/fmt/colors";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { Temporal } from "temporal-polyfill";
import {
  detectBuildConfig,
  FrameworkFileSystemReader,
} from "@deno/framework-detect";
import open from "open";
import { Spinner } from "@std/cli/unstable-spinner";

import {
  createTrpcClient,
  getAuth,
  interactive,
  tokenExchange,
} from "./auth.ts";
import token_storage from "./token_storage.ts";
import { getAppFromConfig, readConfig, writeConfig } from "./config.ts";
import type { GlobalOptions } from "./main.ts";

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
 */
export async function withApp(
  debug: boolean,
  deployUrl: string,
  canCreate: false,
  org: string | undefined,
  app: string | undefined | null,
  quiet?: boolean,
  rootPath?: string,
): Promise<{ org: string; app: string; created: false }>;
export async function withApp(
  debug: boolean,
  deployUrl: string,
  canCreate: true,
  org: string | undefined,
  app: string | undefined | null,
  quiet?: boolean,
  rootPath?: string,
): Promise<{ org: string; app: string; created: true }>;
export async function withApp(
  debug: boolean,
  deployUrl: string,
  canCreate: boolean,
  org: string | undefined,
  app: string | undefined | null,
  quiet?: boolean,
  rootPath = Deno.cwd(),
): Promise<{ org: string; app: string | null; created: boolean }> {
  await getAuth(debug, deployUrl, quiet);

  if (!org) {
    org = Deno.env.get("DENO_DEPLOY_ORG");
  }
  if (app === undefined) {
    app = Deno.env.get("DENO_DEPLOY_APP");
  }

  let created = false;

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
        created: false,
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
      const createdOrgAndApp = await create(debug, deployUrl, rootPath, org);
      org = createdOrgAndApp.org;
      app = createdOrgAndApp.app;
      created = true;
    } else {
      app = selectedApp.value.slug;
      console.log(`Selected application '${selectedApp.value.slug}'`);
    }
  }

  return {
    org,
    app,
    created,
  };
}

export async function ensureOrg(
  options: GlobalOptions & { org?: string },
  quiet: boolean = true,
): Promise<{ org: string; saveConfig: () => Promise<void> }> {
  const config = await readConfig(Deno.cwd(), options.config);
  const configContent = getAppFromConfig(config);

  const app = await withApp(
    options.debug,
    options.endpoint,
    false,
    options.org ?? configContent.org,
    null,
    quiet,
  );

  let saveConfig = () => Promise.resolve();
  if (config && !configContent.org && app.org) {
    saveConfig = () => writeConfig(config, app.org);
  }

  return {
    org: app.org,
    saveConfig,
  };
}

export async function create(
  debug: boolean,
  deployUrl: string,
  rootPath: string,
  initOrg?: string,
): Promise<{ org: string; app: string }> {
  let verifier;
  let exchangeToken;

  const buildConfig = await detectBuildConfig(
    new FrameworkFileSystemReader(rootPath),
  );

  const deviceCreate = await fetch(`${deployUrl}/api/device_create`, {
    method: "POST",
    body: JSON.stringify({
      buildConfig,
    }),
  });
  const { id: deviceCreateId } = await deviceCreate.json();

  const url = new URL(`${deployUrl!}/device-create/${deviceCreateId}`);

  if (initOrg) {
    url.searchParams.set("org", initOrg);
  }

  const storedAuth = token_storage.get();

  if (!storedAuth) {
    const res = await interactive(debug, deployUrl);
    url.searchParams.set("code", res.code);
    verifier = res.verifier;
    exchangeToken = res.exchangeToken;
  }

  const spinner = new Spinner({
    message: `Visit ${url.href} to create a new application.`,
    color: "yellow",
  });
  spinner.start();

  await open(url.href);

  const appCreationPromise = new Promise<{ org: string; app: string }>(
    (resolve, reject) => {
      const interval = setInterval(async () => {
        const res = await fetch(
          `${deployUrl!}/api/device_create/${deviceCreateId}`,
          {
            method: "GET",
          },
        );

        if (res.ok) {
          const appCreation = await res.json();
          clearInterval(interval);
          resolve(appCreation);
        } else {
          const err = await res.json();
          if (err.code !== "APP_CREATION_REQUEST_PENDING") {
            clearInterval(interval);
            reject(new Error(err.message));
          }
        }
      }, 2000);
    },
  );

  const [{ org, app }] = await Promise.all([
    appCreationPromise,
    storedAuth ? undefined : tokenExchange(
      debug,
      deployUrl,
      exchangeToken!,
      verifier!,
      spinner,
      false,
    ),
  ]);

  spinner.stop();
  console.log(
    `${green("✔")} App '${app}' created in the '${org}' organization.\n`,
  );

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

export function parseSize(size: string): number {
  const match = size.match(/^(\d+)(GB|MB|KB|GiB|MiB|KiB)$/i);
  if (!match) {
    error(
      false,
      "Invalid size format. Examples of valid size: '2gb', '1gib', '1000mb', '1024mib'",
    );
  }
  const [, numStr, unit] = match;
  const num = parseFloat(numStr);

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

  throw new Error("unreachable");
}

export type SubTable = {
  headers: string[];
  rows: string[][];
};

export function tablePrinter<T>(
  headers: string[],
  values: T[],
  transformer: (value: T) => string[],
  subtableGenerator?: (value: T) => SubTable | undefined,
) {
  const padding = headers.map((header) => header.length);

  const processed = values.map((value) => {
    const transformed = transformer(value);

    for (let i = 0; i < transformed.length; i++) {
      padding[i] = Math.max(padding[i], stripAnsiCode(transformed[i]).length);
    }

    const subtable = subtableGenerator?.(value);
    let processedSubtable: { padding: number[]; rows: string[][] } | undefined;

    if (subtable && subtable.rows.length > 0) {
      const subPadding = subtable.headers.map((header) => header.length);

      for (const row of subtable.rows) {
        for (let i = 0; i < row.length; i++) {
          subPadding[i] = Math.max(
            subPadding[i],
            stripAnsiCode(row[i]).length,
          );
        }
      }

      processedSubtable = { padding: subPadding, rows: subtable.rows };
    }

    return {
      row: transformed,
      subtable: subtable?.headers,
      processedSubtable,
    };
  });

  console.log(
    headers.map((header, i) => header.padEnd(padding[i])).join("   "),
  );

  for (let i = 0; i < processed.length; i++) {
    const { row, subtable, processedSubtable } = processed[i];

    console.log(row.map((field, i) => field.padEnd(padding[i])).join("   "));

    if (subtable && processedSubtable) {
      console.log(
        "  " +
          subtable
            .map((header, i) => header.padEnd(processedSubtable.padding[i]))
            .join("   "),
      );

      for (const subRow of processedSubtable.rows) {
        console.log(
          "  " +
            subRow
              .map((field, i) => field.padEnd(processedSubtable.padding[i]))
              .join("   "),
        );
      }

      if (i < processed.length - 1) {
        console.log();
      }
    }
  }
}
