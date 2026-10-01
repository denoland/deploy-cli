import { createTrpcClient, type TRPCClient } from "../../auth.ts";
import { resolve } from "@std/path";
import { green } from "@std/fmt/colors";
import { error } from "../../util.ts";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import {
  type BuildConfig,
  detectBuildConfig,
  type DetectedBuildConfig,
  detectWorkspace,
  FrameworkFileSystemReader,
  SUPPORTED_FRAMEWORK_PRESETS,
  type WorkspaceDetectionResult,
  type WorkspaceMember,
} from "@deno/framework-detect";
import type { GlobalContext } from "../../main.ts";
import type { CreateApp, Repo } from "./mod.ts";
import { requireInteractive } from "../../util.ts";

export const AVAILABLE_BUILD_TIMEOUTS = [5, 10, 15, 20, 25, 30];
export const AVAILABLE_BUILD_MEMORY_LIMITS = [1024, 2048, 3072, 4096];
export const REGIONS = ["us", "eu", "global"];

const DURATION_UNIT_MINUTES: Record<string, number> = {
  s: 1 / 60,
  m: 1,
  h: 60,
};

/**
 * Parses `--build-timeout`: a number of minutes (`10`, as the flag has always
 * taken), or a whole number with a unit suffix as in deno.json (`"600s"`,
 * `"10m"`). Returns the timeout in minutes if it is one of the available
 * steps (5 to 30 minutes), and null otherwise.
 */
export function parseBuildTimeoutFlag(value: string): number | null {
  const match = /^([1-9][0-9]*)([smh])$/.exec(value);
  // Without a unit, convert as the flag's former numeric type did, so that
  // spellings such as `10.0` keep working.
  const minutes = match === null
    ? Number(value)
    : Number(match[1]) * DURATION_UNIT_MINUTES[match[2]];
  return AVAILABLE_BUILD_TIMEOUTS.includes(minutes) ? minutes : null;
}

/**
 * The build config detected in an app directory that is not a detected
 * workspace member, locally or in the GitHub repo. A deploy still applies its
 * deno.json `deploy` section, so `create` must know about it.
 */
export async function customDirectoryBuildConfig(
  trpcClient: TRPCClient,
  rootPath: string,
  repo: Repo,
  path: string,
): Promise<DetectedBuildConfig | null> {
  if (repo !== undefined) {
    return await trpcClient.query("github.detectBuildConfigForRepo", {
      owner: repo.owner,
      repo: repo.repo,
      path,
    }) as DetectedBuildConfig | null;
  }
  return await detectBuildConfig(
    new FrameworkFileSystemReader(resolve(rootPath, path)),
  ).catch(() => null);
}

/**
 * The build timeout a detected build config asks for (deno.json
 * `deploy.buildTimeout`), as the largest available step not above it or
 * `maxBuildTimeout`.
 */
export function detectedBuildTimeout(
  buildConfig: BuildConfig | null | undefined,
  maxBuildTimeout = Infinity,
): number | undefined {
  const timeout = buildConfig?.buildTimeout;
  if (timeout === undefined) return undefined;
  const limit = Math.min(timeout, maxBuildTimeout);
  return AVAILABLE_BUILD_TIMEOUTS.findLast((t) => t <= limit) ??
    AVAILABLE_BUILD_TIMEOUTS[0];
}

/**
 * `detectedBuildTimeout`, capped to the organization's plan maximum: the
 * console caps a deno.json timeout when it builds, but `apps.create` rejects
 * one above the plan outright. Only asks the console when there is something
 * to cap.
 */
export async function detectedBuildTimeoutForOrg(
  trpcClient: TRPCClient,
  org: string,
  buildConfig: BuildConfig | null | undefined,
): Promise<number | undefined> {
  const timeout = detectedBuildTimeout(buildConfig);
  if (timeout === undefined || timeout <= AVAILABLE_BUILD_TIMEOUTS[0]) {
    return timeout;
  }
  const orgs = await trpcClient.query("orgs.list") as Array<{
    id: string;
    slug: string;
    subscription_metadata?: { max_build_timeout?: number };
  }>;
  const maxBuildTimeout = orgs.find((o) => o.slug === org || o.id === org)
    ?.subscription_metadata?.max_build_timeout;
  return detectedBuildTimeout(buildConfig, maxBuildTimeout);
}

/**
 * The `deploy` section of deno.json takes precedence over the app's stored
 * build configuration on every deploy, so settings given to `create` that
 * differ from it would never be used.
 */
export const DENO_JSON_PRECEDENCE_WARNING =
  "This app's deno.json has a `deploy` section, which takes precedence over " +
  "the build configuration given here on every deploy. To change the build " +
  "configuration, edit deno.json instead.";

const NA = "(n/a)";
const TITLES = {
  organization: "organization",
  appName: "app name",
  githubOwner: "github owner",
  githubRepo: "github repo",
  appDirectory: "app directory",
  source: "source",
  frameworkPreset: "framework preset",
  installCommand: "install command",
  buildCommand: "build command",
  preDeployCommand: "pre-deploy command",
  mode: "runtime mode",
  entrypoint: "entrypoint",
  arguments: "arguments",
  workingDirectory: "working directory",
  staticDir: "static directory",
  spa: "single page app",
  buildTimeout: "build timeout",
  buildMemoryLimit: "build memory limit",
  regions: "regions",
} as const;
type Title = typeof TITLES[(keyof typeof TITLES)];
const TITLE_LENGTH = Object.values(TITLES).reduce(
  (acc, title) => Math.max(acc, title.length),
  0,
);

function logTitle(
  title: Title,
  value: string | undefined,
) {
  console.log(
    `${(title + ":").padEnd(TITLE_LENGTH + 1)} ${green(value ?? NA)}`,
  );
}

export async function createFlow(
  context: GlobalContext,
  rootPath: string,
  preselectedOrg?: string,
  /** An explicit `--build-timeout`, which takes precedence over a detected one. */
  explicitBuildTimeout?: number,
): Promise<CreateApp> {
  requireInteractive(
    context,
    "Use explicit flags (--org, --app, --source, etc.) to create an app non-interactively.",
  );
  const trpcClient = createTrpcClient(context);

  let org;
  const orgs = await trpcClient.query("orgs.list") as Array<{
    name: string;
    slug: string;
    id: string;
  }>;

  if (preselectedOrg) {
    const fullOrg = orgs.find((org) => org.slug === preselectedOrg)!;
    org = fullOrg.slug;
    logTitle(TITLES.organization, fullOrg.name);
  } else if (orgs.length === 1) {
    org = orgs[0].slug;
    logTitle(TITLES.organization, orgs[0].name);
  } else {
    const selectedOrg = promptSelect(
      "Select an organization:",
      orgs.map((org) => ({ label: `${org.name} (${org.slug})`, value: org })),
      {
        clear: true,
        fitToRemainingHeight: true,
      },
    );
    if (!selectedOrg) {
      error(context, "No organization was selected.");
    }

    org = selectedOrg.value.slug;
    logTitle(TITLES.organization, selectedOrg.value.name);
  }

  const appName = promptWithPrint(TITLES.appName, undefined, true);

  const selectedSource = promptSelect(
    "Do you want to deploy from a github repo or locally?",
    ["github", "local"],
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!selectedSource) {
    error(context, "No source was selected.");
  }
  logTitle(TITLES.source, selectedSource);

  let appDirectories;
  let repo: Repo = undefined;

  if (selectedSource === "github") {
    const githubInfo = await github(context, trpcClient);
    appDirectories = githubInfo.appDirectories;
    repo = {
      owner: githubInfo.owner,
      repo: githubInfo.repo,
    };
  } else {
    appDirectories = await detectWorkspace(
      new FrameworkFileSystemReader(rootPath),
    );
  }

  const appDirectorySelectOptions: PromptEntry<WorkspaceMember | null>[] =
    appDirectories.members.map((member) => ({
      label: `${member.path || "(root)"} (${
        member.buildConfig.frameworkPreset || "no preset"
      })`,
      value: member,
    }));
  appDirectorySelectOptions.push({ label: "custom", value: null });

  const selectedAppDirectory = promptSelectWithInput(
    context,
    "Select an app directory:",
    appDirectorySelectOptions,
    "No github app directory selected.",
  );
  const appDirectoryPath = typeof selectedAppDirectory === "string"
    ? selectedAppDirectory
    : selectedAppDirectory.path;
  logTitle(TITLES.appDirectory, appDirectoryPath || "(root)");

  let buildConfig: DetectedBuildConfig | null;
  if (typeof selectedAppDirectory === "string") {
    buildConfig = appDirectories.members.find((member) =>
      member.path === selectedAppDirectory
    )?.buildConfig ??
      await customDirectoryBuildConfig(
        trpcClient,
        rootPath,
        repo,
        selectedAppDirectory,
      );
  } else {
    buildConfig = selectedAppDirectory.buildConfig;
  }

  let finalBuildConfig: BuildConfig;
  if (buildConfig) {
    const renderedBuildConfig = renderBuildConfig(buildConfig);
    const renderedBuildConfigLines = renderedBuildConfig.split("\n").length;
    Deno.stdout.writeSync(
      new TextEncoder().encode(
        `\n${renderedBuildConfig}\x1b[${renderedBuildConfigLines}A\x1b[0G`,
      ),
    );
    const useDetected = confirm(
      "Do you want to use the detected build configuration?",
    );
    Deno.stdout.writeSync(
      new TextEncoder().encode(`\x1b[${renderedBuildConfigLines}B`),
    );
    clearPreviousLines(renderedBuildConfigLines + 1);

    if (!useDetected) {
      if (buildConfig.from === "deno.json") {
        console.warn(DENO_JSON_PRECEDENCE_WARNING);
      }
      finalBuildConfig = getBuildConfig(context, buildConfig);
    } else {
      finalBuildConfig = buildConfig;
      logTitle(TITLES.installCommand, buildConfig.installCommand);
      logTitle(TITLES.buildCommand, buildConfig.buildCommand);
      logTitle(TITLES.preDeployCommand, buildConfig.preDeployCommand);
      logTitle(TITLES.mode, buildConfig.mode ?? "(internally optimized)");

      switch (buildConfig.mode) {
        case "dynamic":
          logTitle(TITLES.entrypoint, buildConfig.entrypoint);
          logTitle(TITLES.arguments, buildConfig.args?.join(" "));
          logTitle(TITLES.workingDirectory, buildConfig.cwd);
          break;
        case "static":
          logTitle(TITLES.staticDir, buildConfig.staticDir);
          logTitle(TITLES.spa, buildConfig.singlePageApp ? "yes" : "no");
          break;
      }
    }
  } else {
    finalBuildConfig = getBuildConfig(context, buildConfig);
  }

  if (
    explicitBuildTimeout !== undefined && finalBuildConfig === buildConfig &&
    buildConfig?.from === "deno.json"
  ) {
    console.warn(DENO_JSON_PRECEDENCE_WARNING);
  }
  let buildTimeout = explicitBuildTimeout ?? await detectedBuildTimeoutForOrg(
    trpcClient,
    org,
    finalBuildConfig,
  );
  // A deno.json `deploy` section decides the timeout on every deploy, an
  // omitted one meaning the default, so there is nothing to ask for.
  if (
    buildTimeout === undefined && buildConfig?.from === "deno.json" &&
    finalBuildConfig === buildConfig
  ) {
    buildTimeout = AVAILABLE_BUILD_TIMEOUTS[0];
  }
  if (buildTimeout === undefined) {
    // TODO: check pro
    const selectedBuildTimeout = promptSelect(
      "build timeout:",
      AVAILABLE_BUILD_TIMEOUTS.map((timeout) => ({
        label: `${timeout} minutes`,
        value: timeout,
      })),
      {
        clear: true,
        fitToRemainingHeight: true,
      },
    );
    if (!selectedBuildTimeout) {
      error(context, "No build timeout was selected.");
    }
    buildTimeout = selectedBuildTimeout.value;
  }
  logTitle(TITLES.buildTimeout, `${buildTimeout} minutes`);

  // TODO: check pro
  const buildMemoryLimit = promptSelect(
    "build memory limit:",
    AVAILABLE_BUILD_MEMORY_LIMITS.map((memory) => ({
      label: `${memory / 1024} GB`,
      value: memory,
    })),
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!buildMemoryLimit) {
    error(context, "No build memory limit was selected.");
  }
  logTitle(TITLES.buildMemoryLimit, buildMemoryLimit.label);

  // TODO: check pro
  const region = promptSelect(
    "regions:",
    REGIONS,
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!region) {
    error(context, "No region was selected.");
  }
  logTitle(TITLES.regions, region);

  if (confirm("Create app?")) {
    return {
      org,
      app: appName,
      repo,
      buildDirectory: appDirectoryPath,
      buildConfig: finalBuildConfig,
      buildTimeout,
      buildMemoryLimit: buildMemoryLimit.value,
      region,
    };
  } else {
    Deno.exit(0);
  }
}

function getBuildConfig(
  context: GlobalContext,
  buildConfig: DetectedBuildConfig | null,
): BuildConfig {
  const selectedFrameworkPreset = promptSelect(
    "Select a framework preset:",
    [...SUPPORTED_FRAMEWORK_PRESETS].map((preset) => ({
      label: preset || "(none)",
      value: preset,
    })),
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!selectedFrameworkPreset) {
    error(context, "No framework preset was selected.");
  }
  const frameworkPreset = selectedFrameworkPreset.value;

  const installCommand = promptWithPrint(
    TITLES.installCommand,
    buildConfig?.installCommand ?? undefined,
    false,
  );
  const buildCommand = promptWithPrint(
    TITLES.buildCommand,
    buildConfig?.buildCommand ?? undefined,
    false,
  );
  const preDeployCommand = promptWithPrint(
    TITLES.preDeployCommand,
    buildConfig?.preDeployCommand ?? undefined,
    false,
  );

  const selectedRuntimeMode = promptSelect(
    "Select runtime mode:",
    [{
      label: "dynamic app",
      value: "dynamic",
    }, {
      label: "static site",
      value: "static",
    }],
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!selectedRuntimeMode) {
    error(context, "No runtime mode was selected.");
  }
  logTitle(TITLES.mode, selectedRuntimeMode.value);

  let finalRuntimeConfiguration: RuntimeConfiguration;
  switch (selectedRuntimeMode.value) {
    case "dynamic": {
      const runtimeConfiguration =
        selectedRuntimeMode.value === buildConfig?.mode ? buildConfig : null;

      const entrypoint = promptWithPrint(
        TITLES.entrypoint,
        runtimeConfiguration?.entrypoint,
        true,
      );
      const args = promptWithPrint(
        TITLES.arguments,
        runtimeConfiguration?.args?.join(" "),
        false,
      );
      const cwd = promptWithPrint(
        TITLES.workingDirectory,
        runtimeConfiguration?.cwd,
        false,
      );

      finalRuntimeConfiguration = {
        mode: "dynamic",
        entrypoint,
        args: args?.split(" "),
        cwd,
      };
      break;
    }
    case "static": {
      const runtimeConfiguration =
        selectedRuntimeMode.value === buildConfig?.mode ? buildConfig : null;

      const staticDir = promptWithPrint(
        TITLES.staticDir,
        runtimeConfiguration?.staticDir,
        true,
      );
      const singlePageApp = confirmWithPrint(TITLES.spa);

      finalRuntimeConfiguration = {
        mode: "static",
        staticDir,
        singlePageApp,
      };
      break;
    }
  }

  return {
    frameworkPreset,
    installCommand,
    buildCommand,
    preDeployCommand,
    ...finalRuntimeConfiguration!,
  };
}

export function renderBuildConfig(buildConfig: BuildConfig) {
  const frameworkPreset = buildConfig.frameworkPreset || "no preset";
  const installCommand = buildConfig.installCommand;
  const buildCommand = buildConfig.buildCommand;
  const preDeployCommand = buildConfig.preDeployCommand;
  const mode = buildConfig.mode ?? "(internally optimized)";

  let titleLen = Math.max(
    TITLES.frameworkPreset.length,
    TITLES.installCommand.length,
    TITLES.buildCommand.length,
    TITLES.preDeployCommand.length,
    TITLES.mode.length,
  );
  let valueLen = Math.max(
    NA.length,
    frameworkPreset.length,
    installCommand?.length ?? 0,
    buildCommand?.length ?? 0,
    preDeployCommand?.length ?? 0,
    mode?.length ?? 0,
  );
  switch (buildConfig.mode) {
    case "dynamic":
      titleLen = Math.max(
        titleLen,
        TITLES.entrypoint.length,
        TITLES.arguments.length,
        TITLES.workingDirectory.length,
      );
      valueLen = Math.max(
        valueLen,
        buildConfig.entrypoint.length,
        buildConfig.args?.join(" ").length ?? 0,
        buildConfig.cwd?.length ?? 0,
      );
      break;
    case "static":
      titleLen = Math.max(titleLen, TITLES.staticDir.length, TITLES.spa.length);
      valueLen = Math.max(
        valueLen,
        buildConfig.staticDir.length,
        (buildConfig.singlePageApp ? "yes" : "no").length,
      );
      break;
  }

  function displayEntry(
    title: Title,
    value: string | undefined,
  ) {
    return `│ ${title.padEnd(titleLen)}  ${(value ?? NA).padEnd(valueLen)} │\n`;
  }

  let out = `╭${"─".repeat(titleLen + valueLen + 4)}╮\n` +
    displayEntry(TITLES.frameworkPreset, frameworkPreset) +
    displayEntry(TITLES.installCommand, installCommand) +
    displayEntry(TITLES.buildCommand, buildCommand) +
    displayEntry(TITLES.preDeployCommand, preDeployCommand) +
    displayEntry(TITLES.mode, mode);

  switch (buildConfig.mode) {
    case "dynamic":
      out += displayEntry(TITLES.entrypoint, buildConfig.entrypoint) +
        displayEntry(TITLES.arguments, buildConfig.args?.join(" ")) +
        displayEntry(TITLES.workingDirectory, buildConfig.cwd);
      break;
    case "static":
      out += displayEntry(TITLES.staticDir, buildConfig.staticDir) +
        displayEntry(TITLES.spa, buildConfig.singlePageApp ? "yes" : "no");
      break;
  }

  return out + `╰${"─".repeat(titleLen + valueLen + 4)}╯`;
}

async function github(
  context: GlobalContext,
  trpcClient: TRPCClient,
) {
  const owners = await trpcClient.query("github.listOrgsForUser") as Array<{
    id: number;
    login: string;
  }>;

  const selectedOwner = promptSelect(
    "Select a github owner:",
    owners.map((owner) => ({ label: owner.login, value: owner })),
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!selectedOwner) {
    error(context, "No github owner was selected.");
  }
  logTitle(TITLES.githubOwner, selectedOwner.value.login);

  const repos = await trpcClient.query(
    "github.listReposInInstallationForUser",
    {
      installation_id: selectedOwner.value.id,
    },
  ) as Array<{
    id: number;
    name: string;
  }>;

  const selectedRepo = promptSelect(
    "Select a github repo:",
    repos.map((repo) => ({ label: repo.name, value: repo })),
    {
      clear: true,
      fitToRemainingHeight: true,
    },
  );
  if (!selectedRepo) {
    error(context, "No github repo was selected.");
  }
  logTitle(TITLES.githubRepo, selectedRepo.value.name);

  const appDirectories = await trpcClient.query(
    "github.detectWorkspaceForRepo",
    {
      owner: selectedOwner.value.login,
      repo: selectedRepo.value.name,
    },
  ) as WorkspaceDetectionResult;

  return {
    appDirectories,
    owner: selectedOwner.value.login,
    repo: selectedRepo.value.name,
  };
}

function promptSelectWithInput<V extends object>(
  context: GlobalContext,
  message: string,
  values: PromptEntry<V | null>[],
  missingMessage: string,
): V | string {
  const selected = promptSelect(message, values, {
    clear: true,
    fitToRemainingHeight: true,
  });

  if (!selected) {
    error(context, missingMessage);
  }

  if (selected.value === null) {
    let cancelled = false;
    const promptCancelHandler = () => {
      cancelled = true;
    };
    Deno.addSignalListener("SIGINT", promptCancelHandler);
    const custom = prompt(message);
    clearPreviousLines(1);
    Deno.removeSignalListener("SIGINT", promptCancelHandler);
    if (cancelled) {
      return promptSelectWithInput(context, message, values, missingMessage);
    } else {
      if (!custom) {
        error(context, missingMessage);
      }

      return custom;
    }
  } else {
    return selected.value as V;
  }
}

function promptWithPrint(
  title: Title,
  value: string | undefined,
  required: false,
): string | undefined;
function promptWithPrint(
  title: Title,
  value: string | undefined,
  required: true,
): string;
function promptWithPrint(
  title: Title,
  value: string | undefined,
  required: boolean,
): string | undefined {
  const res = prompt(`${title}:`, value)!;
  clearPreviousLines(1);

  if (required && !res) {
    return promptWithPrint(title, value, required);
  }

  logTitle(title, res);

  if (required) {
    return res;
  } else {
    return res || undefined;
  }
}

function confirmWithPrint(title: Title) {
  const res = confirm(`${title}:`);
  clearPreviousLines(1);
  logTitle(title, res ? "yes" : "no");
  return res;
}

function clearPreviousLines(lines: number) {
  let code = "";
  for (const _ of Array(lines)) {
    code += "\x1b[1A\r\x1b[2K";
  }
  code += "\x1b[1A";
  console.log(code);
}

export type RuntimeConfiguration =
  | DynamicRuntimeConfiguration
  | StaticRuntimeConfiguration
  | {
    mode?: undefined;
  };

export type DynamicRuntimeConfiguration = {
  mode: "dynamic";
  entrypoint: string;
  args?: string[];
  cwd?: string;
};

export type StaticRuntimeConfiguration = {
  mode: "static";
  staticDir: string;
  singlePageApp?: boolean;
};
