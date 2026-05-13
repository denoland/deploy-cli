import { Command } from "@cliffy/command";
import { createTrpcClient } from "../auth.ts";
import { actionHandler } from "../config.ts";
import type { GlobalContext } from "../main.ts";
import { tablePrinter, writeJsonResult } from "../util.ts";

interface OrgItem {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
}

const orgsListCommand = new Command<GlobalContext>()
  .description("List organizations the current token can access")
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    const trpcClient = createTrpcClient(options);

    const orgs = await trpcClient.query("orgs.list") as OrgItem[];

    if (options.json) {
      writeJsonResult(orgs.map((org) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        plan: org.plan,
      })));
      return;
    }

    if (orgs.length === 0) {
      console.log("No organizations accessible with this token.");
      return;
    }

    tablePrinter(
      ["SLUG", "NAME", "PLAN"],
      orgs,
      (org) => [org.slug, org.name, org.plan ?? "—"],
    );
  }));

export const orgsCommand = new Command<GlobalContext>()
  .description("List organizations")
  .action(() => {
    orgsCommand.showHelp();
  })
  .command("list", orgsListCommand)
  .alias("ls");
