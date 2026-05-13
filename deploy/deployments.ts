import { Command } from "@cliffy/command";
import { createTrpcClient } from "../auth.ts";
import { actionHandler, getApp, getOrg } from "../config.ts";
import type { GlobalContext } from "../main.ts";
import {
  renderTemporalTimestamp,
  tablePrinter,
  writeJsonResult,
} from "../util.ts";

interface RevisionItem {
  id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  prod: boolean;
  steps: Array<{ step: string }>;
}

const deploymentStatuses = [
  "skipped",
  "queued",
  "building",
  "succeeded",
  "failed",
] as const;
type DeploymentStatus = typeof deploymentStatuses[number];

const deploymentsListCommand = new Command<GlobalContext>()
  .description("List deployments (revisions) for an application")
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .option(
    "--limit <n:number>",
    "Maximum number of deployments to return (default 20)",
  )
  .option("--cursor <c:string>", "Pagination cursor from a previous --json run")
  .option(
    "--status <status:string>",
    `Filter by status: one of ${deploymentStatuses.join(", ")}`,
  )
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    // Cliffy widens the option through its option-builder generics; the
    // backend zod-validates and returns a USAGE error if it's not one of
    // the enum values, which the global error envelope surfaces fine.
    const status = options.status as unknown as DeploymentStatus | undefined;

    const res = await trpcClient.query("revisions.listByPage", {
      org,
      app,
      cursor: options.cursor,
      limit: options.limit ?? 20,
      status,
    }) as { items: RevisionItem[]; nextCursor: string | null };

    if (options.json) {
      writeJsonResult({
        items: res.items.map((r) => ({
          id: r.id,
          status: r.status,
          prod: r.prod,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          lastStep: r.steps.at(-1)?.step ?? null,
        })),
        nextCursor: res.nextCursor,
        org,
        app,
      });
      return;
    }

    if (res.items.length === 0) {
      console.log("No deployments for this application.");
      return;
    }

    tablePrinter(
      ["REVISION", "STATUS", "PROD", "CREATED", "LAST STEP"],
      res.items,
      (r) => [
        r.id,
        r.status,
        r.prod ? "yes" : "no",
        renderTemporalTimestamp(r.created_at.toISOString()),
        r.steps.at(-1)?.step ?? "—",
      ],
    );

    if (res.nextCursor) {
      console.log(`\nMore results available; pass --cursor ${res.nextCursor}`);
    }
  }));

export const deploymentsCommand = new Command<GlobalContext>()
  .description("Manage deployments (revisions)")
  .action(() => {
    deploymentsCommand.showHelp();
  })
  .command("list", deploymentsListCommand)
  .alias("ls");
