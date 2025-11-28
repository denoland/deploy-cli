import { Command } from "@cliffy/command";
import { getAppFromConfig, readConfig } from "./config.ts";
import { renderTemporalTimestamp, withApp } from "./util.ts";
import { createTrpcClient } from "./auth.ts";
import { Sandbox } from "@deno/sandbox";

export const sandboxListCommand = new Command()
  .description("List all sandboxes in an organization")
  .action(async (options) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org } = getAppFromConfig(configContent);
    org ??= options.org;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      null,
    );

    const client = createTrpcClient(options.debug, options.endpoint);

    const list: Array<{
      id: string;
      status: "running" | "stopped";
      created_at: Date;
      stopped_at: Date | null;
      // deno-lint-ignore no-explicit-any
    }> = await (client.sandboxes as any).list.query({
      org: orgAndApp.org,
    });

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
      const formattedDuration = formatPassedTime(duration);

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

    console.log(
      `${"ID".padEnd(idHeaderLength)}   ${
        "Created At".padEnd(createdAtHeaderLength)
      }   ${"Status".padEnd(statusHeaderLength)}   ${
        "Uptime".padEnd(uptimeHeaderLength)
      }\n`,
    );

    for (const sandbox of processed) {
      console.log(
        `${sandbox.id}   ${sandbox.createdAt.padEnd(createdAtHeaderLength)}   ${
          sandbox.status.padEnd(statusHeaderLength)
        }   ${sandbox.duration.padEnd(uptimeHeaderLength)}`,
      );
    }
  });

export const sandboxKillCommand = new Command()
  .description("Kill a running sandbox")
  .arguments("<sandbox-id:string>")
  .action(async (options, sandboxId) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org } = getAppFromConfig(configContent);
    org ??= options.org;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      null,
    );

    const client = createTrpcClient(options.debug, options.endpoint);

    const cluster = await (client.sandboxes as any).findHostname.query({
      org: orgAndApp.org,
      sandboxId,
    });

    const res = await (client.sandboxes as any).kill.mutate({
      org: orgAndApp.org,
      sandboxId,
      clusterHostname: [cluster.hostname]
    });

    if (res.success) {
      console.log(`Sandbox ${sandboxId} killed successfully`);
    }
  });

export const sandboxSshCommand = new Command()
  .description("SSH into a running sandbox")
  .arguments("<sandbox-id:string>")
  .action(async (options, sandboxId) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org } = getAppFromConfig(configContent);
    org ??= options.org;

    const orgAndApp = await withApp(
      options.debug,
      options.endpoint,
      false,
      org,
      null,
    );

    const client = createTrpcClient(options.debug, options.endpoint);

    const [cluster, token] = await Promise.all([
      (client.sandboxes as any).findHostname.query({
        org: orgAndApp.org,
        sandboxId,
      }),
      (client.orgs as any).accessTokens.create.mutate({
        org: orgAndApp.org,
        description: "$$DENO_DEPLOY_CLI_SSH_TOKEN$$",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      }),
    ]);

    await using sandbox = Sandbox.connect({
      id: sandboxId,
      endpoint: cluster.hostname,
      debug: options.debug,
      token: token.token,
    });

    const ssh = await sandbox.exposeSsh();

    console.log(
      `Started ssh session, you can now connect to ${ssh.username}@${ssh.hostname}.\nUse Ctrl+C to exit.`,
    );
  });

export function formatPassedTime(ms: number, roundToSeconds = false) {
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
  if (seconds > 0 || roundToSeconds) {
    const tmp = ms - seconds * secondsMs;

    if (count < 1 && tmp > 0 && !roundToSeconds) {
      const v = Math.round((ms / 1000) * 10) / 10;
      if (count > 0) str += " ";
      str += `${v}s`;
      return str;
    }
    if (count > 0) str += " ";
    str += `${seconds}s`;
    if (roundToSeconds) return str;
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
