import { Command } from "@cliffy/command";
import { ensureOrg, type SandboxContext } from "./mod.ts";
import { getAuth } from "../auth.ts";
import { Client } from "@deno/sandbox";
import { formatSize, tablePrinter } from "../util.ts";

export const snapshotsCreateCommand = new Command<SandboxContext>()
  .description("Create a snapshot from a volume")
  .arguments("<volumeIdOrSlug:string> <snapshotSlug:string>")
  .action(async (options, volumeIdOrSlug, snapshotSlug) => {
    const { org, saveConfig } = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const snapshot = await client.volumes.snapshot(volumeIdOrSlug, {
      slug: snapshotSlug,
    });
    console.log(snapshot.id);
    await saveConfig();
  });

export const snapshotsListCommand = new Command<SandboxContext>()
  .description("List snapshots")
  .arguments("[search:string]")
  .action(async (options, search) => {
    const { org, saveConfig } = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const list = await client.snapshots.list({
      limit: 100,
      search,
    });

    await saveConfig();

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
  });

export const snapshotsDeleteCommand = new Command<SandboxContext>()
  .description("Remove a snapshot")
  .arguments("<idOrSlug:string>")
  .action(async (options, idOrSlug) => {
    const { org, saveConfig } = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    await client.snapshots.delete(idOrSlug);
    await saveConfig();
  });

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
