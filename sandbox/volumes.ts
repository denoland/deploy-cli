import { Command } from "@cliffy/command";
import { ensureOrg, type SandboxContext } from "./mod.ts";
import { getAuth } from "../auth.ts";
import { Client } from "@deno/sandbox";
import { formatSize, parseSize, tablePrinter } from "../util.ts";

export const volumesCreateCommand = new Command<SandboxContext>()
  .description("Create a volume")
  .option("--capacity <string|number>", "The capacity of the volume", {
    required: true,
  })
  .option("--region <string>", "The region of the volume", { required: true })
  .arguments("<name>")
  .action(async (options, name) => {
    const { org, saveConfig } = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    const volume = await client.volumes.create({
      slug: name,
      capacity: parseSize(options.capacity),
      region: options.region,
    });

    await saveConfig();

    console.log(volume.id);
  });

export const volumesListCommand = new Command<SandboxContext>()
  .description("List volumes")
  .arguments("[search:string]")
  .action(async (options, search) => {
    const { org, saveConfig } = await ensureOrg(options);
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

    await saveConfig();

    tablePrinter(
      ["ID", "SLUG", "REGION", "USED", "TOTAL"],
      list.items,
      (volume) => {
        return [
          volume.id,
          volume.slug,
          volume.region,
          formatSize(volume.used),
          formatSize(volume.capacity),
        ];
      },
    );
  });

export const volumesDeleteCommand = new Command<SandboxContext>()
  .description("Remove a volume")
  .arguments("<idOrSlug:string>")
  .action(async (options, idOrSlug) => {
    const { org, saveConfig } = await ensureOrg(options);
    const token = await getAuth(options.debug, options.endpoint, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    await client.volumes.delete(idOrSlug);
    await saveConfig();
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
