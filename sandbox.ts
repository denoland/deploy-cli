import { Command } from "@cliffy/command";
import { Sandbox } from "@deno/sandbox";
import { green, magenta, red } from "@std/fmt/colors";

import { getAppFromConfig, readConfig, writeConfig } from "./config.ts";
import { error, renderTemporalTimestamp, withApp } from "./util.ts";
import { createTrpcClient, getAuth } from "./auth.ts";
import type { GlobalOptions } from "./main.ts";
import { Spinner } from "@std/cli/unstable-spinner";

type SandboxContext = GlobalOptions & {
  org?: string;
};

export const sandboxCreateCommand = new Command<SandboxContext>()
  .description("Create a new sandbox in an organization")
  .option("--lifetime <duration:string>", "The lifetime of the sandbox", {
    default: "session",
  })
  .option("--copy <path:string>", "Copy files or directories to the sandbox", {
    collect: true,
  })
  .example(
    "Copying files from a local directory",
    "new --copy ./app",
  )
  .action(async (options) => {
    const org = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const sandbox = await Sandbox.create({
      debug: options.debug,
      token,
      org,
      // deno-lint-ignore no-explicit-any
      lifetime: options.lifetime as any,
    });

    if (options.copy) {
      await Promise.all(
        options.copy.map((path) => sandbox.upload(path, "/app")),
      );
    }

    console.log(sandbox.id);

    if (options.lifetime === "session") {
      Deno.addSignalListener("SIGINT", async () => {
        await sandbox.close();
        Deno.exit();
      });
    } else {
      Deno.exit();
    }
  });

export const sandboxListCommand = new Command<SandboxContext>()
  .description("List all sandboxes in an organization")
  .action(async (options) => {
    const org = await ensureOrg(options);
    const client = createTrpcClient(options.debug, options.endpoint, true);

    const list: Array<{
      id: string;
      status: "running" | "stopped";
      created_at: Date;
      stopped_at: Date | null;
      // deno-lint-ignore no-explicit-any
    }> = await (client.sandboxes as any).list.query({ org });

    let createdAtHeaderLength = 0;
    let statusHeaderLength = 0;
    let idHeaderLength = 0;
    let uptimeHeaderLength = 0;

    const processed = list.map((sandbox) => {
      let duration;

      if (sandbox.stopped_at) {
        duration = sandbox.stopped_at.getTime() - sandbox.created_at.getTime();
      } else {
        duration = new Date().getTime() - sandbox.created_at.getTime();
      }

      const createdAt = renderTemporalTimestamp(
        sandbox.created_at.toISOString(),
      );
      const formattedDuration = formatDuration(duration);

      createdAtHeaderLength = Math.max(createdAt.length, createdAtHeaderLength);
      statusHeaderLength = Math.max(sandbox.status.length, statusHeaderLength);
      idHeaderLength = Math.max(sandbox.id.length, idHeaderLength);
      uptimeHeaderLength = Math.max(
        formattedDuration.length,
        uptimeHeaderLength,
      );

      return {
        createdAt,
        duration: formattedDuration,
        id: sandbox.id,
        status: sandbox.status,
      };
    });

    console.log([
      "ID".padEnd(idHeaderLength),
      "CREATED".padEnd(createdAtHeaderLength),
      "STATUS".padEnd(statusHeaderLength),
      "UPTIME".padEnd(uptimeHeaderLength),
    ].join("   "));

    for (const sandbox of processed) {
      const isRunning = sandbox.status === "running";
      const status = sandbox.status.padEnd(statusHeaderLength);
      console.log(
        [
          sandbox.id.padEnd(idHeaderLength),
          sandbox.createdAt.padEnd(createdAtHeaderLength),
          isRunning ? green(status) : red(status),
          sandbox.duration.padEnd(uptimeHeaderLength),
        ].join("   "),
      );
    }
  });

export const sandboxKillCommand = new Command<SandboxContext>()
  .description("Kill a running sandbox")
  .arguments("<sandbox-id:string>")
  .action(async (options, sandboxId) => {
    const org = await ensureOrg(options);
    const client = createTrpcClient(options.debug, options.endpoint, true);

    // deno-lint-ignore no-explicit-any
    const cluster = await (client.sandboxes as any).findHostname.query({
      org,
      sandboxId,
    });

    // deno-lint-ignore no-explicit-any
    const res = await (client.sandboxes as any).kill.mutate({
      org,
      sandboxId,
      clusterHostname: cluster.hostname,
    });

    if (res.success) {
      console.log(`Sandbox ${sandboxId} killed successfully`);
    }
  });

export const sandboxSshCommand = new Command<SandboxContext>()
  .description("SSH into a running sandbox")
  .arguments("<sandbox-id:string>")
  .action(async (options, sandboxId) => {
    await using sandbox = await connectToSandbox(options, sandboxId);
    await sshIntoSandbox(sandbox);
  });

export const sandboxCopyCommand = new Command<SandboxContext>()
  .description("Copy files from or to a running sandbox")
  /*.example(
    "Copy a file from a sandbox to the local machine",
    "copy someSandboxId:/app/remote-file.txt ./local-file.txt",
  )*/
  .example(
    "Copy a file from the local machine to a sandbox",
    "copy ./local-file.txt someSandboxId:/app/remote-file.txt",
  )
  /*.example(
    "Copy multiple files from a sandbox to the local machine",
    "copy someSandboxId:/app/remote-file.txt someSandboxId:/app/another-remote-file.txt ./",
  )*/
  .example(
    "Copy multiple files from the local machine to a sandbox",
    "copy ./local-file.txt ./another-local-file.txt someSandboxId:/app/",
  )
  .example(
    "Copy a directory from the local machine to a sandbox",
    "copy ./ ./another-local-file.txt someSandboxId:/app/",
  )
  /*.example(
    "Copy files from a sandbox to another sandbox",
    "copy someSandboxId:/app/remote-file.txt anotherSandboxId:/app/remote-file.txt",
  )*/
  .arguments("<paths...:string>")
  .action(async (options, ...paths) => {
    if (paths.length < 2) {
      error(options.debug, "Not enough paths were specified");
    }

    const target = paths.pop()!;

    if (target.includes(":")) {
      const [sandboxId, sandboxPath] = target.split(":");
      await using sandbox = await connectToSandbox(options, sandboxId);

      //const sourceSandboxPaths = [];
      const localPaths = [];

      for (const path of paths) {
        if (path.includes(":")) {
          error(
            options.debug,
            "Copying between sandboxes is currently not supported",
          );

          //sourceSandboxPaths.push(path);
        } else {
          localPaths.push(path);
        }
      }

      /*const sourceSandboxGroups = groupPathsBySandbox(sourceSandboxPaths);
      const sourceSandboxes: Record<string, Sandbox> = {};

      for (const sandboxId of Object.keys(sourceSandboxGroups)) {
        sourceSandboxes[sandboxId] = await connectToSandbox(options, sandboxId);
      }*/

      await Promise.all([
        ...localPaths.map((path) => {
          return sandbox.upload(path, sandboxPath);
        }),
        /*...Object.entries(sourceSandboxGroups).map(
          async ([sandboxId, sourceSandboxPaths]) => {
            const sourceSandbox = sourceSandboxes[sandboxId];

            await Promise.all(
              sourceSandboxPaths.map(async (sourceSandboxPath) => {
                const tempDir = await Deno.makeTempDir();
                await sourceSandbox.download(sourceSandboxPath, tempDir);
                await sandbox.upload(tempDir, target);
              }),
            );

            await sandbox.close();
          },
        ),*/
      ]);
    } else {
      error(options.debug, "Copying from sandboxes is currently not supported");

      /*for (const path of paths) {
        if (!path.includes(":")) {
          error(
            options.debug,
            "Source paths must be in the format <sandbox-id>:<path>",
          );
        }
      }

      const groups = groupPathsBySandbox(paths);
      const sandboxes: Record<string, Sandbox> = {};

      for (const sandboxId of Object.keys(groups)) {
        sandboxes[sandboxId] = await connectToSandbox(options, sandboxId);
      }

      await Promise.all(
        Object.entries(groups).map(async ([sandboxId, sandboxPaths]) => {
          const sandbox = sandboxes[sandboxId];

          await Promise.all(sandboxPaths.map((sandboxPath) => {
            return sandbox.download(sandboxPath, target);
          }));

          await sandbox.close();
        }),
      );*/
    }
  });

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
  .arguments("<sandbox-id:string> <command...:string>")
  .action(async (options, sandboxId, ...command) => {
    await using sandbox = await connectToSandbox(options, sandboxId);

    const child = await sandbox.spawn("bash", {
      cwd: options.cwd,
      args: ["-c", command.join(" ")],
      stdout: options.quiet ? "null" : "inherit",
      stderr: options.quiet ? "null" : "inherit",
    });

    const status = await child.status;
    Deno.exit(status.code);
  });

export const sandboxRunCommand = new Command<SandboxContext>()
  .description("Create a sandbox and run a command")
  .example(
    "Create a sandbox and run a command",
    "run ls /",
  )
  .example(
    "Copying files from a local directory and then running a command",
    "run --copy ./app ls",
  )
  .option("-q, --quiet", "Don't pipe the command to the console")
  .option("--cwd <path:string>", "Working directory of the command")
  .option("--copy <path:string>", "Copy files or directories to the sandbox", {
    collect: true,
  })
  .option("--lifetime <duration:string>", "The lifetime of the sandbox", {
    default: "session",
  })
  .option("--expose-http <port:number>", "Expose the specified port")
  .arguments("<command...>")
  .action(async function (options, ...command) {
    const org = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const sandbox = await Sandbox.create({
      debug: options.debug,
      token,
      org,
      // deno-lint-ignore no-explicit-any
      lifetime: options.lifetime as any,
    });

    console.log(`Created sandbox with id '${sandbox.id}'`);

    if (options.copy) {
      const spinner = new Spinner({
        message: "Copying files to the sandbox...",
        color: "yellow",
      });
      spinner.start();

      await Promise.all(
        options.copy.map((path) => sandbox.upload(path, "/app")),
      );

      spinner.stop();
    }

    if (options.exposeHttp) {
      const url = await sandbox.exposeHttp({ port: options.exposeHttp });
      console.log(`Exposed port ${options.exposeHttp} to ${url}`);
    }

    console.log();

    const child = await sandbox.spawn("bash", {
      cwd: options.cwd,
      args: ["-c", command.join(" ")],
      stdout: options.quiet ? "null" : "inherit",
      stderr: options.quiet ? "null" : "inherit",
    });

    const status = await child.status;
    Deno.exit(status.code);
  });

/*
export const sandboxExtendCommand = new Command<SandboxContext>()
  .description("Extend the lifetime of a running sandbox")
  .arguments("<sandbox-id:string> <lifetime:string>")
  .action(async (options, sandboxId, lifetime) => {
    await using sandbox = await connectToSandbox(options, sandboxId);

    console.log(await sandbox.extendLifetime(lifetime));
  });
*/

/*
function groupPathsBySandbox(paths: string[]): Record<string, string[]> {
  const groups = {};

  for (const path of paths) {
    const [sandboxId, sandboxPath] = path.split(":");
    if (!groups[sandboxId]) {
      groups[sandboxId] = [];
    }
    groups[sandboxId].push(sandboxPath);
  }

  return groups;
}*/

async function ensureOrg(options: SandboxContext) {
  const config = await readConfig(Deno.cwd(), options.config);
  const configContent = getAppFromConfig(config);

  const app = await withApp(
    options.debug,
    options.endpoint,
    false,
    options.org ?? configContent.org,
    null,
    true,
  );

  if (!configContent.org && app.org) {
    await writeConfig(config, app.org);
  }

  return app.org;
}

async function connectToSandbox(
  options: SandboxContext,
  sandboxId: string,
): Promise<Sandbox> {
  const org = await ensureOrg(options);
  const client = createTrpcClient(options.debug, options.endpoint, true);
  const token = await getAuth(options.debug, options.endpoint, true);
  // deno-lint-ignore no-explicit-any
  const cluster = await (client.sandboxes as any).findHostname.query({
    org,
    sandboxId,
  });

  return await Sandbox.connect({
    id: sandboxId,
    region: cluster.region,
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

/**
 * Format duration in ms to human readable string
 *
 * @example
 *   86400000 => 1d
 *    7200000 => 2h
 *     180000 => 3m
 *       4000 => 4s
 *          5 => 5ms
 *
 * @param ms
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return "0s";

  const secondsMs = 1000;
  const minMs = 1000 * 60;
  const hoursMs = 1000 * 60 * 60;
  const daysMs = 1000 * 60 * 60 * 24;

  let str = "";
  let count = 0;

  const days = Math.floor(ms / daysMs);
  if (days > 0) {
    ms = ms - days * daysMs;
    str += `${days}d`;
    count++;
  }

  const hours = Math.floor(ms / hoursMs);
  if (hours > 0) {
    ms = ms - hours * hoursMs;
    if (count > 0) str += " ";
    str += `${hours}h`;
    count++;
  }

  if (count > 1 || (count > 0 && hours === 0)) return str;

  const mins = Math.floor(ms / minMs);
  if (mins > 0) {
    ms = ms - mins * minMs;
    if (count > 0) str += " ";
    str += `${mins}m`;
    count++;
  }
  if (count > 1 || (count > 0 && mins === 0)) return str;

  const seconds = Math.floor(ms / secondsMs);
  if (seconds > 0) {
    const tmp = ms - seconds * secondsMs;

    if (count < 1 && tmp > 0) {
      const v = Math.round((ms / 1000) * 10) / 10;
      if (count > 0) str += " ";
      str += `${v}s`;
      return str;
    }
    if (count > 0) str += " ";
    str += `${seconds}s`;
    ms = tmp;
    count++;
  }
  if (count > 1 || (count > 0 && seconds === 0)) return str;

  if (ms > 0) {
    if (count > 0) str += " ";
    const v = Math.round(ms * 100) / 100;
    str += `${v}ms`;
  }

  return str;
}

export const sandboxCommand = new Command<GlobalOptions>()
  .description("Interact with sandboxes")
  .globalOption("--org <name:string>", "The name of the organization")
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
  .command("run", sandboxRunCommand)
  //.command("extend", sandboxExtendCommand)
  .command("ssh", sandboxSshCommand);
