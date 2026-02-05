import { Command } from "@cliffy/command";
import type { SandboxContext } from "./mod.ts";
import { getAuth } from "../auth.ts";
import { Client } from "@deno/sandbox";
import { formatSize, tablePrinter } from "../util.ts";
import { actionHandler, getOrg } from "../config.ts";

export const snapshotsCreateCommand = new Command<SandboxContext>()
  .description("Create a snapshot from a volume")
  .arguments("<volumeIdOrSlug:string> <snapshotSlug:string>")
  .action(
    actionHandler(async (config, options, volumeIdOrSlug, snapshotSlug) => {
      config.noCreate();
      const org = await getOrg(options, config, options.org);
      const token = await getAuth(options, true);

      const client = new Client({
        apiEndpoint: options.endpoint,
        token,
        org,
      });

      const snapshot = await client.volumes.snapshot(volumeIdOrSlug, {
        slug: snapshotSlug,
      });
      console.log(snapshot.id);
    }),
  );

export const snapshotsListCommand = new Command<SandboxContext>()
  .description("List snapshots")
  .arguments("[search:string]")
  .action(actionHandler(async (config, options, search) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const token = await getAuth(options, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const list = await client.snapshots.list({
      limit: 100,
      search,
    });

    tablePrinter(
      ["ID", "SLUG", "REGION", "ALLOCATED", "FLATTENED", "BOOTABLE", "BASE"],
      list.items,
      (snapshot) => {
        return [
          snapshot.id,
          snapshot.slug,
          snapshot.region,
          formatSize(snapshot.allocatedSize),
          formatSize(snapshot.flattenedSize),
          snapshot.isBootable.toString().toUpperCase(),
          snapshot.volume.slug,
        ];
      },
    );
  }));

export const snapshotsDeleteCommand = new Command<SandboxContext>()
  .description("Remove a snapshot")
  .arguments("<idOrSlug:string>")
  .action(actionHandler(async (config, options, idOrSlug) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const token = await getAuth(options, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    await client.snapshots.delete(idOrSlug);
  }));

export const snapshotsCommand = new Command<SandboxContext>()
  .description("Manage sandbox snapshots")
  .action(() => {
    snapshotsCommand.showHelp();
  })
  .command("create", snapshotsCreateCommand)
  .alias("new")
  .command("list", snapshotsListCommand)
  .alias("ls")
  .command("delete", snapshotsDeleteCommand)
  .alias("remove")
  .alias("rm");
