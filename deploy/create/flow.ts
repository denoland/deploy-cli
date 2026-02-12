import { createTrpcClient, type TRPCClient } from "../../auth.ts";
import { green } from "@std/fmt/colors";
import { error } from "../../util.ts";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import {
  type BuildConfig,
  type DetectedBuildConfig,
  detectWorkspace,
  FrameworkFileSystemReader,
  SUPPORTED_FRAMEWORK_PRESETS,
  type WorkspaceDetectionResult,
  type WorkspaceMember,
} from "@deno/framework-detect";
import type { GlobalContext } from "../../main.ts";
import type { CreateApp, Repo } from "./mod.ts";

export const AVAILABLE_BUILD_TIMEOUTS = [5, 10, 15, 20, 25, 30];
export const AVAILABLE_BUILD_MEMORY_LIMITS = [1024, 2048, 3072, 4096];
export const REGIONS = ["us", "eu", "global"];

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
): Promise<CreateApp> {
  const trpcClient = createTrpcClient(context);

  let org;
  const orgs = await trpcClient.query("orgs.list") as Array<{
    name: string;
    slug: string;
    id: string;
  }>;

  if (orgs.length === 1) {
    org = orgs[0].slug;
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
    )?.buildConfig ?? null;
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

  // TODO: check pro
  const buildTimeout = promptSelect(
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
  if (!buildTimeout) {
    error(context, "No build timeout was selected.");
  }
  logTitle(TITLES.buildTimeout, buildTimeout.label);

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
      buildTimeout: buildTimeout.value,
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
