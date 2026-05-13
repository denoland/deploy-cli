import { Command } from "@cliffy/command";
import { createTrpcClient } from "../auth.ts";
import { actionHandler, getOrg } from "../config.ts";
import type { GlobalContext } from "../main.ts";
import {
  renderTemporalTimestamp,
  tablePrinter,
  writeJsonResult,
} from "../util.ts";

interface AppItem {
  id: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
  layers: Array<{ slug: string }>;
}

const appsListCommand = new Command<GlobalContext>()
  .description("List applications in an organization")
  .option("--org <name:string>", "The name of the organization")
  .option("--limit <n:number>", "Maximum number of apps to return (default 20)")
  .option("--cursor <c:string>", "Pagination cursor from a previous --json run")
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const trpcClient = createTrpcClient(options);

    const res = await trpcClient.query("apps.listByPage", {
      cursor: options.cursor,
      limit: options.limit ?? 20,
    }) as { items: AppItem[]; nextCursor: string | null };

    if (options.json) {
      writeJsonResult({
        items: res.items.map((app) => ({
          id: app.id,
          slug: app.slug,
          createdAt: app.created_at,
          updatedAt: app.updated_at,
          layers: app.layers.map((l) => l.slug),
        })),
        nextCursor: res.nextCursor,
        org,
      });
      return;
    }

    if (res.items.length === 0) {
      console.log("No applications in this organization.");
      return;
    }

    tablePrinter(
      ["SLUG", "CREATED", "UPDATED", "LAYERS"],
      res.items,
      (app) => [
        app.slug,
        renderTemporalTimestamp(app.created_at.toISOString()),
        renderTemporalTimestamp(app.updated_at.toISOString()),
        app.layers.map((l) => l.slug).join(", ") || "—",
      ],
    );

    if (res.nextCursor) {
      console.log(`\nMore results available; pass --cursor ${res.nextCursor}`);
    }
  }));

export const appsCommand = new Command<GlobalContext>()
  .description("Manage applications")
  .action(() => {
    appsCommand.showHelp();
  })
  .command("list", appsListCommand)
  .alias("ls");
