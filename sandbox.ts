import { Command } from "@cliffy/command";
import { Sandbox } from "@deno/sandbox";
import { green, magenta, red } from "@std/fmt/colors";

import { getAppFromConfig, readConfig } from "./config.ts";
import { renderTemporalTimestamp, withApp } from "./util.ts";
import { createTrpcClient, getAuth } from "./auth.ts";
import type { GlobalOptions } from "./main.ts";

type SandboxContext = GlobalOptions & {
  org?: string;
};

export const sandboxNewCommand = new Command<SandboxContext>()
  .description("Create a new sandbox in an organization")
  .action(async (options) => {
    const org = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint);

    const sandbox = await Sandbox.create({
      debug: options.debug,
      token: token,
      org,
    });

    const success = await sshIntoSandbox(sandbox);
    const stopMessage = "Stopping the sandbox...";
    if (success) {
      // Closes the sandbox only when ssh session was established and finished successfully
      await sandbox.close();
      console.log(stopMessage);
    } else {
      // Otherwise, keep the sandbox running and wait for Ctrl+C
      console.log("\nCtrl+C to stop the sandbox.");
      Deno.addSignalListener("SIGINT", async () => {
        console.log("\n" + stopMessage);
        await sandbox.close();
        Deno.exit();
      });
    }
  });

export const sandboxListCommand = new Command<SandboxContext>()
  .description("List all sandboxes in an organization")
  .action(async (options) => {
    const org = await ensureOrg(options);
    const client = createTrpcClient(options.debug, options.endpoint);

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
    const client = createTrpcClient(options.debug, options.endpoint);

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
    const org = await ensureOrg(options);
    const client = createTrpcClient(options.debug, options.endpoint);
    const token = await getAuth(options.debug, options.endpoint);
    // deno-lint-ignore no-explicit-any
    const cluster = await (client.sandboxes as any).findHostname.query({
      org,
      sandboxId,
    });

    await using sandbox = await Sandbox.connect({
      id: sandboxId,
      region: cluster.region,
      debug: options.debug,
      token: token,
      org,
    });
    await sshIntoSandbox(sandbox);
  });

async function ensureOrg(options: SandboxContext) {
  const org = options.org ??
    getAppFromConfig(await readConfig(Deno.cwd(), options.config)).org;

  return (await withApp(
    options.debug,
    options.endpoint,
    false,
    org,
    null,
  )).org;
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
