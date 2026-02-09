import { Command, ValidationError } from "@cliffy/command";
import type { GlobalContext } from "../../main.ts";
import { actionHandler } from "../../config.ts";
import {
  AVAILABLE_BUILD_MEMORY_LIMITS,
  AVAILABLE_BUILD_TIMEOUTS,
  createFlow,
  REGIONS,
  renderBuildConfig,
} from "./flow.ts";
import { createTrpcClient, getAuth } from "../../auth.ts";
import {
  type BuildConfig,
  detectWorkspace,
  FrameworkFileSystemReader,
  type FrameworkPreset,
  SUPPORTED_FRAMEWORK_PRESETS,
  type WorkspaceDetectionResult,
} from "@deno/framework-detect";

import { publish } from "../publish.ts";

export const createCommand = new Command<GlobalContext>()
  .description(
    "Create a new application. If none of the flags are specified, the flow will be run interactively.",
  )
  .option(
    "--allow-node-modules",
    "Allow node_modules directory to be included when uploading",
  )
  .option("--no-wait", "Skip waiting for the build to complete")
  .option(
    "--dry-run",
    "Validate and process the flags or execute the flow without creation the app",
  )
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .group("Source Options")
  .option("--source <source:string>", "The source of the application", {
    value(value: string) {
      if (value === "github" || value === "local") {
        return value;
      }
      throw new ValidationError(
        `Invalid source: ${value}. alid values are "github" and "local".`,
      );
    },
  })
  .option("--owner <name:string>", "The owner of the repository")
  .option("--repo <name:string>", "The name of the repository", {
    depends: ["owner"],
  })
  .group("Build configuration")
  .option(
    "--app-directory <path:string>",
    "The path to the application directory",
  )
  .option("--use-detected-build-config", "Use detected build configuration")
  .option("--framework-preset <preset:string>", "The framework preset to use", {
    value(value: string) {
      if (SUPPORTED_FRAMEWORK_PRESETS.has(value as FrameworkPreset)) {
        return value as FrameworkPreset;
      } else {
        throw new ValidationError(
          `Invalid runtime configuration: ${value}. Valid values are ${
            [...SUPPORTED_FRAMEWORK_PRESETS].filter((val) => val).map((
              preset,
            ) => `"${preset}"`)
              .join(", ")
          }.`,
        );
      }
    },
  })
  .option("--install-command <command:string>", "The install command to use")
  .option("--build-command <command:string>", "The build command to use")
  .option(
    "--pre-deploy-command <command:string>",
    "The pre-deploy command to use",
  )
  .option(
    "--runtime-mode <config:string>",
    "The pre-deploy command to use",
    {
      value(value: string) {
        if (value === "dynamic" || value === "static") {
          return value;
        } else {
          throw new ValidationError(
            `Invalid runtime mode: ${value}. Valid values are "dynamic" and "static".`,
          );
        }
      },
    },
  )
  .option(
    "--entrypoint <entrypoint:string>",
    "The entrypoint to use for dynamic configuration",
  )
  .option(
    "--arguments <arguments:string>",
    "The arguments to use for dynamic configuration. Can be specified multiple times.",
    {
      collect: true,
    },
  )
  .option(
    "--working-directory <cwd:string>",
    "The working directory to use for dynamic configuration",
  )
  .option(
    "--static-dir <cwd:string>",
    "The directory your static site should be served from to use for static configuration",
  )
  .option(
    "--single-page-app",
    "When enabled: All requests that don't match a static file will serve index.html from the root directory.\n" +
      "When disabled: All requests that don't match a static file will return a 404 error.\n" +
      "For static configuration",
  )
  .option(
    "--build-timeout <seconds:number>",
    `The build timeout in minutes. One of ${
      AVAILABLE_BUILD_TIMEOUTS.join(", ")
    }`,
    {
      value(value: number) {
        if (AVAILABLE_BUILD_TIMEOUTS.includes(value)) {
          return value;
        } else {
          throw new ValidationError(
            `Invalid build timeout: ${value}. Valid values are ${
              AVAILABLE_BUILD_TIMEOUTS.join(", ")
            }.`,
          );
        }
      },
    },
  )
  .option(
    "--build-memory-limit <megabytes:number>",
    `The build memory limit in megabytes. One of ${
      AVAILABLE_BUILD_MEMORY_LIMITS.join(", ")
    }`,
    {
      value(value: number) {
        if (AVAILABLE_BUILD_MEMORY_LIMITS.includes(value)) {
          return value;
        } else {
          throw new ValidationError(
            `Invalid build memory limit: ${value}. Valid values are ${
              AVAILABLE_BUILD_MEMORY_LIMITS.join(", ")
            }.`,
          );
        }
      },
    },
  )
  .option(
    "--region <region:string>",
    `The region to deploy to. One of ${REGIONS.join(", ")}`,
    {
      value(value: string) {
        if (REGIONS.includes(value)) {
          return value;
        } else {
          throw new ValidationError(
            `Invalid region: ${value}. Valid values are ${REGIONS.join(", ")}.`,
          );
        }
      },
    },
  )
  .arguments("[root-path:string]")
  .action(actionHandler(async (config, options, rootPath = Deno.cwd()) => {
    await getAuth(options);
    let data;
    if (
      options.org ||
      options.app ||
      options.source ||
      options.owner ||
      options.repo ||
      options.appDirectory ||
      options.frameworkPreset ||
      options.installCommand ||
      options.buildCommand ||
      options.preDeployCommand ||
      options.runtimeMode ||
      options.entrypoint ||
      options.arguments ||
      options.workingDirectory ||
      options.staticDir ||
      options.singlePageApp ||
      options.buildTimeout ||
      options.buildMemoryLimit ||
      options.region
    ) {
      const org = require(options.org, "org");
      const app = require(options.app, "app");
      const source = require(options.source, "source");
      let repo: Repo = undefined;
      let appDirectories: WorkspaceDetectionResult;
      if (source === "github") {
        repo = {
          owner: require(options.owner, "owner"),
          repo: require(options.repo, "repo"),
        };

        const trpcClient = createTrpcClient(options);
        // deno-lint-ignore no-explicit-any
        appDirectories = await (trpcClient.github as any).detectWorkspaceForRepo
          .query(repo);
      } else {
        appDirectories = await detectWorkspace(
          new FrameworkFileSystemReader(rootPath),
        );
      }

      const member = appDirectories.members.find((member) =>
        member.path === options.appDirectory
      );

      const buildDirectory = member?.path ??
        require(options.appDirectory, "app-directory");

      let buildConfig;
      if (options.useDetectedBuildConfig) {
        if (member?.buildConfig) {
          buildConfig = member?.buildConfig;
        } else {
          throw new ValidationError(
            `No build configuration was detected in '${buildDirectory}'.`,
          );
        }
      } else {
        buildConfig = {
          frameworkPreset: options.frameworkPreset ?? "",
          installCommand: requireUnless(
            options.installCommand,
            options.frameworkPreset,
            "install-command",
          ),
          buildCommand: requireUnless(
            options.buildCommand,
            options.frameworkPreset,
            "build-command",
          ),
          preDeployCommand: requireUnless(
            options.preDeployCommand,
            options.frameworkPreset,
            "pre-deploy-command",
          ),
        };

        const runtimeMode = requireUnless(
          options.runtimeMode,
          options.frameworkPreset,
          "runtime-mode",
        );
        buildConfig.mode = runtimeMode;

        switch (runtimeMode) {
          case "dynamic": {
            buildConfig.entrypoint = require(options.entrypoint, "entrypoint");
            buildConfig.args = options.arguments;
            buildConfig.cwd = options.workingDirectory;
            break;
          }
          case "static": {
            buildConfig.staticDir = require(options.staticDir, "static-dir");
            buildConfig.spa = options.singlePageApp ?? false;
            break;
          }
        }
      }

      const buildTimeout = require(options.buildTimeout, "build-timeout");
      const buildMemoryLimit = require(
        options.buildMemoryLimit,
        "build-memory-limit",
      );
      const region = require(options.region, "region");

      console.log("Using the following build configuration:");
      console.log(renderBuildConfig(buildConfig satisfies BuildConfig));

      data = {
        org,
        app,
        repo,
        buildDirectory,
        buildConfig: buildConfig satisfies BuildConfig,
        buildTimeout,
        buildMemoryLimit,
        region,
      };
    } else {
      data = await createFlow(options, rootPath);
    }
    if (options.dryRun) {
      await createApp(
        options,
        data,
        rootPath,
        options.allowNodeModules,
        options.wait,
      );
      config.org = data.org;
      config.app = data.app;
    }
  }, (rootPath) => rootPath));

function require<T>(value: T | undefined, option: string): T {
  if (value === undefined) {
    throw new ValidationError(`Missing required option "--${option}".`);
  } else {
    return value;
  }
}

function requireUnless<T>(
  value: T | undefined,
  unless: unknown | undefined,
  option: string,
): T | undefined {
  if (unless) {
    throw new ValidationError(`Missing required option "--${option}".`);
  } else {
    return value;
  }
}

export type Repo = { owner: string; repo: string } | undefined;

export interface CreateApp {
  org: string;
  app: string;
  repo: Repo;
  buildDirectory: string;
  buildConfig: BuildConfig;
  buildTimeout: number;
  buildMemoryLimit: number;
  region: string;
}

async function createApp(
  context: GlobalContext,
  data: CreateApp,
  rootPath: string,
  allowNodeModules: boolean | undefined,
  wait: boolean | undefined,
) {
  const trpcClient = createTrpcClient(context);
  const buildConfig = {
    ...data.buildConfig,
    buildDirectory: data.buildDirectory,
    buildTimeout: data.buildTimeout,
    buildMemoryLimit: data.buildMemoryLimit,
  };

  let deviceCreation = undefined;
  if (data.repo === undefined) {
    const deviceCreate = await fetch(`${context.endpoint}/api/device_create`, {
      method: "POST",
      body: JSON.stringify({
        buildConfig,
      }),
    });
    const { id } = await deviceCreate.json();
    deviceCreation = id;
  }

  // deno-lint-ignore no-explicit-any
  await (trpcClient.apps as any).create.mutate({
    org: data.org,
    slug: data.app,
    repo: data.repo,
    buildConfig,
    envVars: [],
    target: data.region,
    deviceCreation,
  });

  if (data.repo === undefined) {
    await publish(
      context,
      rootPath,
      data.org,
      data.app,
      true,
      allowNodeModules ?? false,
      wait ?? true,
    );
  }

  console.log(
    `Created app, view it at ${context.endpoint}/${data.org}/${data.app}`,
  );
}
