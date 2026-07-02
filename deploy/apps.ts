import { Command } from "@cliffy/command";
import { createTrpcClient } from "../auth.ts";
import { actionHandler, getApp, getOrg } from "../config.ts";
import type { GlobalContext } from "../main.ts";
import {
  renderTemporalTimestamp,
  selectProductionUrl,
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

interface AppDetail {
  id: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
  build_config: { frameworkPreset?: string | null } | null;
}

interface TimelineEntry {
  partition_config_name: string;
  context_name: string;
  active_revision_id: string | null;
  domains: string[];
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
      org,
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
      console.error("No applications in this organization.");
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
      console.error(
        `\nMore results available; pass --cursor ${res.nextCursor}`,
      );
    }
  }));

const appsGetCommand = new Command<GlobalContext>()
  .description("Show an application, including its production URL and domains")
  .option("--org <name:string>", "The name of the organization")
  .option("--app <name:string>", "The name of the application")
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    // Domains live on revision timelines, not the app record.
    const [detail, revisions] = await Promise.all([
      trpcClient.query("apps.get", { org, app }) as Promise<AppDetail>,
      trpcClient.query("revisions.listByPage", {
        org,
        app,
        limit: 1,
      }) as Promise<{ items: Array<{ id: string }> }>,
    ]);

    let timelines: TimelineEntry[] = [];
    const latestRevision = revisions.items[0]?.id;
    if (latestRevision) {
      timelines = await trpcClient.query("revisions.listTimelines", {
        org,
        app,
        revision: latestRevision,
      }) as TimelineEntry[];
    }

    const { timeline: production, domains, productionUrl } =
      selectProductionUrl(timelines);

    if (options.json) {
      writeJsonResult({
        id: detail.id,
        slug: detail.slug,
        org,
        productionUrl,
        domains,
        productionRevisionId: production?.active_revision_id ?? null,
        frameworkPreset: detail.build_config?.frameworkPreset ?? null,
        createdAt: detail.created_at,
        updatedAt: detail.updated_at,
        timelines: timelines.map((t) => ({
          partition: t.partition_config_name,
          context: t.context_name,
          activeRevisionId: t.active_revision_id,
          domains: t.domains.map((d) => `https://${d}`),
        })),
      });
      return;
    }

    console.log(`App:            ${detail.slug}`);
    console.log(`Production URL: ${productionUrl ?? "—"}`);

    if (timelines.length > 0) {
      console.log();
      tablePrinter(
        ["PARTITION", "CONTEXT", "DOMAINS"],
        timelines,
        (t) => [
          t.partition_config_name,
          t.context_name,
          t.domains.map((d) => `https://${d}`).join(", ") || "—",
        ],
      );
    }
  }));

export const appsCommand = new Command<GlobalContext>()
  .description("Manage applications")
  .action(() => {
    appsCommand.showHelp();
  })
  .command("list", appsListCommand)
  .alias("ls")
  .command("get", appsGetCommand);
