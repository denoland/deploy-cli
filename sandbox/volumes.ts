import { Command } from "@cliffy/command";
import { ensureOrg, type SandboxContext } from "./mod.ts";
import { getAuth } from "../auth.ts";
import { Client, type VolumeInit } from "@deno/sandbox";
import { tablePrinter } from "../util.ts";

export const volumesCreateCommand = new Command<SandboxContext>()
  .description("Create a volume")
  .option("--name <string>", "The name of the volume", { required: true })
  .option("--capacity <string|number>", "The capacity of the volume", {
    required: true,
  })
  .option("--region <string>", "The region of the volume", { required: true })
  .action(async (options) => {
    const org = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const volume = await client.volumes.create({
      slug: options.name,
      capacity: options.capacity as VolumeInit["capacity"],
      region: options.region,
    });

    console.log(volume.id);
  });

export const volumesListCommand = new Command<SandboxContext>()
  .description("List volumes")
  .arguments("[search:string]")
  .action(async (options, search) => {
    const org = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

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
      ["ID", "SLUG", "REGION", "USED", "TOTAL"],
      list.items,
      (volume) => {
        const used = volume.used.toFixed(2).toString();
        const total = volume.capacity.toFixed(2).toString();

        return [
          volume.id,
          volume.slug,
          volume.region,
          used,
          total,
        ];
      },
    );
  });

export const volumesDeleteCommand = new Command<SandboxContext>()
  .description("Remove a volume")
  .arguments("<idOrSlug:string>")
  .action(async (options, idOrSlug) => {
    const org = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    await client.volumes.delete(idOrSlug);
  });

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
  .alias("rm");
