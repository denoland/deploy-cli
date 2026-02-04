import { Command } from "@cliffy/command";
import type { SandboxContext } from "./mod.ts";
import { getAuth } from "../auth.ts";
import { Client } from "@deno/sandbox";
import { formatSize, parseSize, tablePrinter } from "../util.ts";
import { actionHandler, getOrg } from "../config.ts";

export const volumesCreateCommand = new Command<SandboxContext>()
  .description("Create a volume")
  .option("--capacity <string|number>", "The capacity of the volume", {
    required: true,
  })
  .option("--region <string>", "The region of the volume", { required: true })
  .option(
    "--from <string>",
    'A base snapshot or image to create the volume from.\nThis can either be a snapshot, or the special string "builtin:debian-13".',
  )
  .arguments("<name>")
  .action(actionHandler(async (config, options, name) => {
    const org = await getOrg(options, config, options.org);
    const token = await getAuth(options, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const volume = await client.volumes.create({
      slug: name,
      capacity: Math.floor(parseSize(options, options.capacity)),
      region: options.region,
      from: options.from,
    });

    console.log(volume.id);
  }));

export const volumesListCommand = new Command<SandboxContext>()
  .description("List volumes")
  .arguments("[search:string]")
  .action(actionHandler(async (config, options, search) => {
    const org = await getOrg(options, config, options.org);
    const token = await getAuth(options, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const list = await client.volumes.list({
      limit: 100,
      search,
    });

    tablePrinter(
      ["ID", "SLUG", "REGION", "USED", "TOTAL", "BASE"],
      list.items,
      (volume) => {
        return [
          volume.id,
          volume.slug,
          volume.region,
          formatSize(volume.estimatedFlattenedSize),
          formatSize(volume.capacity),
          volume.baseSnapshot ? volume.baseSnapshot.slug : "",
        ];
      },
    );
  }));

export const volumesDeleteCommand = new Command<SandboxContext>()
  .description("Remove a volume")
  .arguments("<idOrSlug:string>")
  .action(actionHandler(async (config, options, idOrSlug) => {
    const org = await getOrg(options, config, options.org);
    const token = await getAuth(options, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    await client.volumes.delete(idOrSlug);
  }));

export const volumesSnapshotCommand = new Command<SandboxContext>()
  .description("Snapshot a volume")
  .arguments("<volumeIdOrSlug:string> <snapshotSlug:string>")
  .action(
    actionHandler(async (config, options, volumeIdOrSlug, snapshotSlug) => {
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

export const volumesCommand = new Command<SandboxContext>()
  .description("Manage sandbox volumes")
  .action(() => {
    volumesCommand.showHelp();
  })
  .command("create", volumesCreateCommand)
  .alias("new")
  .command("list", volumesListCommand)
  .alias("ls")
  .command("delete", volumesDeleteCommand)
  .alias("remove")
  .alias("rm")
  .command("snapshot", volumesSnapshotCommand);
