import { Command, ValidationError } from "@cliffy/command";
import {
  type Region,
  Sandbox,
  type VolumeId,
  type VolumeSlug,
} from "@deno/sandbox";
import { green, magenta, red } from "@std/fmt/colors";
import { pooledMap } from "@std/async";
import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import { Spinner } from "@std/cli/unstable-spinner";

import {
  formatDuration,
  parseSize,
  renderTemporalTimestamp,
  tablePrinter,
} from "../util.ts";
import { createTrpcClient, getAuth, tokenStorage } from "../auth.ts";
import { createSwitchCommand, type GlobalContext } from "../main.ts";

import { volumesCommand } from "./volumes.ts";
import { snapshotsCommand } from "./snapshot.ts";
import { actionHandler, type ConfigContext, getOrg } from "../config.ts";

export type SandboxContext = GlobalContext & {
  org?: string;
};

export const sandboxCreateCommand = new Command<SandboxContext>()
  .description("Create a new sandbox in an organization")
  .option("--timeout <duration:string>", "The timeout of the sandbox", {
    default: "session",
  })
  .option("--copy <path:string>", "Copy files or directories to the sandbox", {
    collect: true,
  })
  .option("-q, --quiet", "Don't pipe the command to the console")
  .option("--cwd <path:string>", "Working directory of the command")
  .option("--ssh", "SSH into the sandbox")
  .option("--expose-http <port:number>", "Expose the specified port")
  .option("--memory <value:string>", "Memory limit for the sandbox")
  .option("--region <string>", "The region of the sandbox")
  .option(
    "--root <volumeOrSnapshot:string>",
    "A volume or snapshot to use as the root filesystem of the sandbox",
  )
  .option(
    "--volume <volume:string>",
    "Mount a volume to the sandbox. Needs to be in format <idOrSlug>:<path>",
    {
      collect: true,
      value: (value, previous = {}): Record<string, VolumeId | VolumeSlug> => {
        const separatorIndex = value.indexOf(":");
        if (separatorIndex === -1) {
          throw new ValidationError(
            "Volume must be specified as <idOrSlug>:<path>",
          );
        }
        const name = value.slice(0, separatorIndex);
        const path = value.slice(separatorIndex + 1);

        if (path === "/") {
          throw new ValidationError(
            "Volume mount  path cannot be /, use --root instead",
          );
        }

        previous[path] = name;

        return previous;
      },
    },
  )
  .arguments("[command...]")
  .example(
    "Create a sandbox and run a command",
    "new ls /",
  )
  .example(
    "Copying files from a local directory",
    "new --copy ./app",
  )
  .example(
    "Create a sandbox with a custom memory limit",
    "new --memory 2gb",
  )
  .action(actionHandler(async function (config, options, ...command) {
    config.noCreate();
    const org = await getOrg(options, config, options.org);

    const quiet = options.timeout === "session";
    const token = await getAuth(options, quiet);

    let memory = undefined;

    if (options.memory) {
      memory = Math.floor(parseSize(options, options.memory));
    }

    const sandbox = await Sandbox.create({
      debug: options.debug,
      token,
      org,
      timeout: options.timeout as `${number}s` | `${number}m` | "session",
      memory,
      volumes: options.volume,
      region: options.region as Region,
      root: options.root,
    });
    if (options.timeout === "session" || options.ssh) {
      console.log(`Created sandbox with id '${sandbox.id}'`);
    }

    if (options.copy) {
      const spinner = new Spinner({
        message: "Copying files to the sandbox...",
        color: "yellow",
      });
      spinner.start();

      await Promise.all(
        options.copy.map((path) => sandbox.fs.upload(path, "/app")),
      );

      spinner.stop();
    }

    if (options.exposeHttp) {
      const url = await sandbox.exposeHttp({ port: options.exposeHttp });
      console.log(`Exposed port ${options.exposeHttp} to ${url}`);
    }

    const args = this.getLiteralArgs().length > 0
      ? this.getLiteralArgs()
      : command;
    if (args.length > 0) {
      const child = await sandbox.spawn("bash", {
        cwd: options.cwd,
        args: ["-c", args.join(" ")],
        stdin: "piped",
        stdout: options.quiet ? "null" : "inherit",
        stderr: options.quiet ? "null" : "inherit",
      });

      Deno.stdin.readable.pipeTo(child.stdin!);

      const status = await child.status;

      if (!status.success) {
        Deno.exit(status.code);
      }
    }

    await config.save();

    const stopMessage = "Stopping the sandbox...";
    if (options.ssh) {
      const success = await sshIntoSandbox(sandbox);
      if (success) {
        // Closes the sandbox only when ssh session was established and finished successfully
        console.log("Disconnecting from the sandbox...");
        await sandbox.close();
      } else {
        // Otherwise, keep the sandbox running and wait for Ctrl+C
        console.log("\nCtrl+C to stop the sandbox.");
        Deno.addSignalListener("SIGINT", async () => {
          console.log("\n" + stopMessage);
          await sandbox.close();
          Deno.exit();
        });
      }
    } else if (options.timeout === "session") {
      // Otherwise, keep the sandbox running and wait for Ctrl+C
      console.log("\nCtrl+C to stop the sandbox.");
      Deno.addSignalListener("SIGINT", async () => {
        console.log("\n" + stopMessage);
        await sandbox.close();
        Deno.exit();
      });
    } else {
      console.log(sandbox.id);

      Deno.exit();
    }
  }));

export const sandboxListCommand = new Command<SandboxContext>()
  .description("List all sandboxes in an organization")
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const client = createTrpcClient(options, true);

    const list = await client.query("sandboxes.list", { org }) as Array<{
      id: string;
      status: "running" | "stopped";
      created_at: Date;
      stopped_at: Date | null;
      cluster_hostname: string;
    }>;

    tablePrinter(
      ["ID", "CREATED", "REGION", "STATUS", "UPTIME"],
      list,
      (sandbox) => {
        let duration;

        if (sandbox.stopped_at) {
          duration = sandbox.stopped_at.getTime() -
            sandbox.created_at.getTime();
        } else {
          duration = new Date().getTime() - sandbox.created_at.getTime();
        }

        const createdAt = renderTemporalTimestamp(
          sandbox.created_at.toISOString(),
        );
        const formattedDuration = formatDuration(duration);
        const isRunning = sandbox.status === "running";

        return [
          sandbox.id,
          createdAt,
          sandbox.cluster_hostname.split(".")[0],
          isRunning ? green(sandbox.status) : red(sandbox.status),
          formattedDuration,
        ];
      },
    );
  }));

export const sandboxKillCommand = new Command<SandboxContext>()
  .description("Kill a running sandbox")
  .argument("<sandbox-id:string>", "The id of the sandbox", {
    default: Deno.env.get("SANDBOX_ID"),
  })
  .action(actionHandler(async (config, options, sandboxId) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const client = createTrpcClient(options, true);

    const cluster = await client.query("sandboxes.findHostname", {
      org,
      sandboxId,
    }) as { hostname: string };

    const res = await client.mutation("sandboxes.kill", {
      org,
      sandboxId,
      clusterHostname: cluster.hostname,
    }) as { success: boolean };

    if (res.success) {
      console.log(`Sandbox ${sandboxId} killed successfully`);
    }
  }));

export const sandboxSshCommand = new Command<SandboxContext>()
  .description("SSH into a running sandbox")
  .argument("<sandbox-id:string>", "The id of the sandbox", {
    default: Deno.env.get("SANDBOX_ID"),
  })
  .action(actionHandler(async (config, options, sandboxId) => {
    config.noCreate();
    await using sandbox = await connectToSandbox(options, config, sandboxId);
    await config.save();
    await sshIntoSandbox(sandbox);
  }));

export const sandboxCopyCommand = new Command<SandboxContext>()
  .description("Copy files from or to a running sandbox")
  .example(
    "Copy a file from a sandbox to the local machine",
    "copy someSandboxId:/app/remote-file.txt ./local-file.txt",
  )
  .example(
    "Copy a file from the local machine to a sandbox",
    "copy ./local-file.txt someSandboxId:/app/remote-file.txt",
  )
  .example(
    "Copy multiple files from a sandbox to the local machine",
    "copy someSandboxId:/app/remote-file.txt someSandboxId:/app/another-remote-file.txt ./",
  )
  .example(
    "Copy multiple files from the local machine to a sandbox",
    "copy ./local-file.txt ./another-local-file.txt someSandboxId:/app/",
  )
  .example(
    "Copy a directory from the local machine to a sandbox",
    "copy ./ ./another-local-file.txt someSandboxId:/app/",
  )
  .example(
    "Copy files from a sandbox to another sandbox",
    "copy someSandboxId:/app/remote-file.txt anotherSandboxId:/app/remote-file.txt",
  )
  .example(
    "Copy all files from a directory in a sandbox to the local machine",
    "copy someSandboxId:/app/* ./",
  )
  .arguments("<paths...:string>")
  .action(actionHandler(async (config, options, ...paths) => {
    config.noCreate();
    if (paths.length < 2) {
      throw new ValidationError("At least two paths must be specified");
    }

    const target = paths.pop()!;

    if (target.includes(":")) {
      const separatorIndex = target.indexOf(":");
      const sandboxId = target.slice(0, separatorIndex);
      const targetSandboxPath = target.slice(separatorIndex + 1);

      await using targetSandbox = await connectToSandbox(
        options,
        config,
        sandboxId,
      );

      const sourceSandboxPaths = [];
      const localPaths = [];

      for (const path of paths) {
        if (path.includes(":")) {
          sourceSandboxPaths.push(path);
        } else {
          localPaths.push(path);
        }
      }

      const sourceSandboxGroups = groupPathsBySandbox(sourceSandboxPaths);
      const sourceSandboxes: Record<string, Sandbox> = {};

      for (const sandboxId of Object.keys(sourceSandboxGroups)) {
        sourceSandboxes[sandboxId] = await connectToSandbox(
          options,
          config,
          sandboxId,
        );
      }

      await Promise.all([
        ...localPaths.map((path) => {
          return targetSandbox.fs.upload(path, targetSandboxPath);
        }),
        ...Object.entries(sourceSandboxGroups).map(
          async ([sandboxId, sourceSandboxPaths]) => {
            const sourceSandbox = sourceSandboxes[sandboxId];

            await Promise.all(
              sourceSandboxPaths.map(async (sourceSandboxPath) => {
                const tempDir = await Deno.makeTempDir();

                await Array.fromAsync(pooledMap(
                  Infinity,
                  sourceSandbox.fs.expandGlob(sourceSandboxPath),
                  async (sandboxEntry) => {
                    const tempPath = join(tempDir, sandboxEntry.path);
                    await Deno.mkdir(tempPath, { recursive: true });
                    await sourceSandbox.fs.download(
                      sandboxEntry.path,
                      tempPath,
                    );

                    await Array.fromAsync(pooledMap(
                      Infinity,
                      expandGlob(`${tempPath}/*`),
                      (localEntry) =>
                        targetSandbox.fs.upload(
                          localEntry.path,
                          join(
                            targetSandboxPath,
                            localEntry.isDirectory
                              ? "./"
                              : `./${localEntry.name}`,
                          ),
                        ),
                    ));
                  },
                ));
              }),
            );

            await sourceSandbox.close();
          },
        ),
      ]);
    } else {
      for (const path of paths) {
        if (!path.includes(":")) {
          throw new ValidationError(
            "Source paths must be in the format <sandbox-id>:<path>",
          );
        }
      }

      const groups = groupPathsBySandbox(paths);
      const sandboxes: Record<string, Sandbox> = {};

      for (const sandboxId of Object.keys(groups)) {
        sandboxes[sandboxId] = await connectToSandbox(
          options,
          config,
          sandboxId,
        );
      }

      await Promise.all(
        Object.entries(groups).map(async ([sandboxId, sandboxPaths]) => {
          const sandbox = sandboxes[sandboxId];

          await Promise.all(sandboxPaths.map(async (sandboxPath) => {
            await Array.fromAsync(pooledMap(
              Infinity,
              sandbox.fs.expandGlob(sandboxPath),
              (entry) => sandbox.fs.download(entry.path, target),
            ));
          }));

          await sandbox.close();
        }),
      );
    }
  }));

export const sandboxExecCommand = new Command<SandboxContext>()
  .description("Execute a command in a running sandbox")
  .example(
    "Execute a command in a sandbox",
    "exec someSandboxId ls",
  )
  .example(
    "Using a specific working directory",
    "exec --cwd /app someSandboxId ls",
  )
  .option("-q, --quiet", "Don't pipe the command to the console")
  .option("--cwd <path:string>", "Working directory of the command")
  .argument("<sandbox-id:string>", "The id of the sandbox", {
    default: Deno.env.get("SANDBOX_ID"),
  })
  .arguments("<command...:string>")
  .action(
    actionHandler(async function (config, options, sandboxId, ...command) {
      config.noCreate();

      await using sandbox = await connectToSandbox(options, config, sandboxId);

      const args = this.getLiteralArgs().length > 0
        ? this.getLiteralArgs()
        : command;
      const child = await sandbox.spawn("bash", {
        cwd: options.cwd,
        args: ["-c", args.join(" ")],
        stdin: "piped",
        stdout: options.quiet ? "null" : "inherit",
        stderr: options.quiet ? "null" : "inherit",
      });

      Deno.stdin.readable.pipeTo(child.stdin!);

      const status = await child.status;
      await config.save();
      Deno.exit(status.code);
    }),
  );

export const sandboxExtendCommand = new Command<SandboxContext>()
  .description("Extend the timeout of a running sandbox")
  .argument("<sandbox-id:string>", "The id of the sandbox", {
    default: Deno.env.get("SANDBOX_ID"),
  })
  .argument("<timeout:string>", "The amount to extend the timeout by")
  .action(actionHandler(async (config, options, sandboxId, timeout) => {
    config.noCreate();
    await using sandbox = await connectToSandbox(options, config, sandboxId);
    console.log(
      await sandbox.extendTimeout(timeout as `${number}s` | `${number}m`),
    );
  }));

export const sandboxDeployCommand = new Command<SandboxContext>()
  .description("Deploy a running sandbox to the specified app")
  .option("--cwd <string>", "The directory to deploy")
  .option("--prod", "Deploy directly to production", { default: false })
  .option("--entrypoint <string>", "The entrypoint to use for the app")
  .option(
    "--args <args...:string>",
    "Arguments to pass to the entrypoint script",
  )
  .argument("<sandbox-id:string>", "The id of the sandbox", {
    default: Deno.env.get("SANDBOX_ID"),
  })
  .argument("<app:string>", "The app to deploy to")
  .action(actionHandler(async (config, options, sandboxId, app) => {
    config.noCreate();
    await using sandbox = await connectToSandbox(options, config, sandboxId);

    await sandbox.deno.deploy(app, {
      path: options.cwd,
      production: options.prod,
      build: {
        entrypoint: options.entrypoint,
        args: options.args,
      },
    });
  }));

function groupPathsBySandbox(paths: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};

  for (const path of paths) {
    const separatorIndex = path.indexOf(":");
    const sandboxId = path.slice(0, separatorIndex);
    const sandboxPath = path.slice(separatorIndex + 1);

    if (!groups[sandboxId]) {
      groups[sandboxId] = [];
    }

    groups[sandboxId].push(sandboxPath);
  }

  return groups;
}

async function connectToSandbox(
  options: SandboxContext,
  config: ConfigContext,
  sandboxId: string,
): Promise<Sandbox> {
  const org = await getOrg(options, config, options.org);
  const token = await getAuth(options, true);

  return await Sandbox.connect({
    id: sandboxId,
    apiEndpoint: options.endpoint,
    debug: options.debug,
    token,
    org,
  });
}

/**
 * Make an ssh connection to the running sandbox. Returns true if ssh session
 * was successfully created and finished, false when ssh is not available and
 * connection info was printed instead.
 */
async function sshIntoSandbox(sandbox: Sandbox): Promise<boolean> {
  const ssh = await sandbox.exposeSsh();
  const connectInfo = ssh.username + "@" + ssh.hostname;

  const which = await new Deno.Command("which", {
    args: ["ssh"],
    stdout: "null",
    stderr: "null",
  }).output();
  if (which.success) {
    console.log(`ssh ${connectInfo}`);
    const command = new Deno.Command("ssh", {
      args: [connectInfo],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const sshProcess = await command.spawn();
    await sshProcess.output();
    await sandbox.close();
    return true;
  } else {
    console.log(
      `Started ssh session. You can now connect to ${magenta(connectInfo)}

Example:
  ssh ${connectInfo}`,
    );
    return false;
  }
}

export const sandboxCommand = new Command<GlobalContext>()
  .name("deno sandbox")
  .description("Interact with sandboxes")
  .globalOption("--endpoint <endpoint:string>", "the endpoint", {
    default: "https://console.deno.com",
    hidden: true,
  })
  .globalOption("--debug", "Enable debug output", {
    hidden: true,
    default: false,
  })
  .globalOption("--token <token:string>", "Auth token to use")
  .globalOption("--config <config:string>", "Path for the config file")
  .globalOption("--org <name:string>", "The name of the organization")
  .globalAction((options) => {
    const endpoint = Deno.env.get("DENO_DEPLOY_ENDPOINT");
    if (endpoint) {
      options.endpoint = endpoint;
    }
    if (options.endpoint.endsWith("/")) {
      throw new ValidationError(
        "The provided DENO_DEPLOY_ENDPOINT is invalid, it cannot end with a slash.",
      );
    }
    const tokenEnv = options.token || Deno.env.get("DENO_DEPLOY_TOKEN");
    if (tokenEnv) {
      tokenStorage.set(tokenEnv, true);
    }
  })
  .action(() => {
    sandboxCommand.showHelp();
  })
  .command("create", sandboxCreateCommand)
  .alias("new")
  .command("list", sandboxListCommand)
  .alias("ls")
  .command("kill", sandboxKillCommand)
  .alias("remove")
  .alias("rm")
  .command("copy", sandboxCopyCommand)
  .alias("cp")
  .command("exec", sandboxExecCommand)
  .command("extend", sandboxExtendCommand)
  .command("ssh", sandboxSshCommand)
  .command("deploy", sandboxDeployCommand)
  .command("volumes", volumesCommand)
  .command("snapshots", snapshotsCommand)
  .command("switch", createSwitchCommand(false));
