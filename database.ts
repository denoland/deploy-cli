import { Command, ValidationError } from "@cliffy/command";
import { createTrpcClient } from "./auth.ts";
import {
  ensureOrg,
  error,
  renderTemporalTimestamp,
  tablePrinter, withApp,
} from "./util.ts";
import type { GlobalOptions } from "./main.ts";
import { parse as parseConnectionString } from "pg-connection-string";
import { getAppFromConfig, readConfig } from "./config.ts";

export type DatabaseContext = GlobalOptions & {
  org?: string;
};

export const databasesProvisionCommand = new Command<DatabaseContext>()
  .description("Provision a database")
  .option("--kind <string>", "The kind of database to provision", {
    required: true,
    value: (value: string): "denokv" | "prisma" => {
      if (value !== "denokv" && value !== "prisma") {
        throw new ValidationError(
          `kind must be either "kv" or "prisma", but got "${value}".`,
        );
      }
      return value;
    },
  })
  .option(
    "--region <string>",
    "The primary region of the database. required for Prisma",
  )
  .arguments("<name:string>")
  .action(async (options, name) => {
    const { org, saveConfig } = await ensureOrg(options, false);
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    if (options.kind === "prisma" && !options.region) {
      // deno-lint-ignore no-explicit-any
      const regions: Array<{ id: string }> = await (trpcClient.databases as any)
        .prismaRegions.query({
          org,
        });

      throw new ValidationError(
        `region is required for Prisma databases.\n  Valid values are: ${
          regions.map((region) => region.id).join(", ")
        }`,
      );
    }

    // deno-lint-ignore no-explicit-any
    await (trpcClient.databases as any).createInstance.mutate({
      org: org,
      slug: name,
      engine: options.kind,
      connection_config:options.kind === "denokv" ? {
        clientId: crypto.randomUUID(),
        region: undefined,
      } : {
        projectId: crypto.randomUUID(),
        region: options.region,
      },
    });

    await saveConfig();
  });

export const databasesLinkCommand = new Command<DatabaseContext>()
  .description("Link a database")
  .option("--hostname <string>", "The hostname to use for the database", {
    required: true,
    conflicts: ["connectionString"],
  })
  .option("--username <string>", "The username to use for the database", {
    conflicts: ["connectionString"],
  })
  .option("--password <string>", "The password to use for the database", {
    conflicts: ["connectionString"],
  })
  .option("--port <number>", "The port to use for the database", {
    conflicts: ["connectionString"],
  })
  .option("--cert <string>", "The SSL certificate to use for the database")
  .option(
    "--dry-run",
    "Don't actually link the database, just attempt to connect",
  )
  .arguments("<name:string> [connectionString:string]")
  .action(async (options, name, connectionString) => {
    const { org, saveConfig } = await ensureOrg(options, false);
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    const engine = "postgresql";
    let hostname;
    let port;
    let username;
    let password;
    if (connectionString) {
      const parsed = parseConnectionString(connectionString);

      if (
        connectionString.startsWith("postgres://") ||
        connectionString.startsWith("postgresql://")
      ) {
        throw new TypeError(
          "Invalid connection string, expected postgres:// or postgresql:// prefix.",
        );
      }

      if (parsed.host) {
        hostname = parsed.host;
      }
      if (parsed.port) {
        port = parsed.port;
      }
      if (parsed.user) {
        username = parsed.user;
      }
      if (parsed.password) {
        password = parsed.password;
      }
    } else {
      hostname = options.hostname;
      port = options.port;
      username = options.username;
      password = options.password;
    }

    const connectionConfig = {
      hostname: hostname,
      port: port || null,
      username: username || null,
      password: password || null,
      certificate: options.cert || null,
    };

    if (options.dryRun) {
      // deno-lint-ignore no-explicit-any
      await (trpcClient.databases as any).testConnection.mutate({
        org: org,
        engine,
        connection_config: connectionConfig,
      });
    } else {
      // deno-lint-ignore no-explicit-any
      await (trpcClient.databases as any).createInstance.mutate({
        org: org,
        slug: name,
        engine,
        connectionConfig,
      });
    }

    await saveConfig();
  });

export const databasesAssignCommand = new Command<DatabaseContext>()
  .description("Assign a database to an app")
  .option("--app <name:string>", "The name of the application")
  .arguments("<name:string>")
  .action(async (options, name) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;
    const orgAndApp = await withApp(
      options.debug,
      options.endpoint as string,
      false,
      org,
      app,
      false,
    );


    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    await (trpcClient.apps as any).assignDatabaseAttachment.mutate({
      org: orgAndApp.org,
      app: orgAndApp.app,
      databaseInstance: name,
    });
  });

export const databasesDetachCommand = new Command<DatabaseContext>()
  .description("Detach a database from an app")
  .option("--app <name:string>", "The name of the application")
  .arguments("<name:string>")
  .action(async (options, name) => {
    const configContent = await readConfig(Deno.cwd(), options.config);
    let { org, app } = getAppFromConfig(configContent);
    org ??= options.org;
    app ??= options.app;
    const orgAndApp = await withApp(
      options.debug,
      options.endpoint as string,
      false,
      org,
      app,
      false,
    );

    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    await (trpcClient.apps as any).removeDatabaseAttachment.mutate({
      org: orgAndApp.org,
      app: orgAndApp.app,
      databaseInstance: name,
    });
  });

export const databasesQueryCommand = new Command<DatabaseContext>()
  .description("Query a database")
  .arguments("<name:string> <database:string> [query...]")
  .action(async function (options, name, database, ...query) {
    const { org, saveConfig } = await ensureOrg(options, false);
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    const args = this.getLiteralArgs().length > 0
      ? this.getLiteralArgs()
      : query;

    // deno-lint-ignore no-explicit-any
    const res = await (trpcClient.databases as any).executeQuery.mutate({
      org,
      databaseInstance: name,
      databaseName: database,
      query: args.join(" "),
      array: false,
    });

    if (res.kind === "ok") {
      console.log(res.rows);
    } else if (res.kind === "postgres_error") {
      error(options.debug, res.error);
    } else if (res.error) {
      error(options.debug, res.message);
    }

    await saveConfig();
  });

type PostgresInfo = {
  engine: "postgresql";
  safeConnectionConfig: {
    hostname: string;
    port: number | null;
    username: string | null;
    customCertificate: boolean;
  };
};
type DenokvInfo = {
  engine: "denokv";
  safeConnectionConfig: {
    clientId: string;
  };
};
type PrismaInfo = {
  engine: "prisma";
  safeConnectionConfig: {
    projectId: string;
    region: string;
    claimedTo?: {
      workspaceId: string;
    };
  };
};

type ConnectionInfo = PostgresInfo | DenokvInfo | PrismaInfo;

export const databasesListCommand = new Command<DatabaseContext>()
  .description("list databases")
  .arguments("[search:string]")
  .action(async (options, search) => {
    const { org, saveConfig } = await ensureOrg(options, false);
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    const list: Array<
      {
        slug: string;
        created_at: Date;
        databases: Array<{ name: string; status: string; created_at: Date }>;
        assignments: Array<{ app_slug: string }>;
      } & ConnectionInfo
    > // deno-lint-ignore no-explicit-any
     = await (trpcClient.databases as any).listInstances.query({
      org: org,
      search,
    });

    tablePrinter(
      ["NAME", "ENGINE", "ASSIGNMENTS", "CONNECTION DETAILS"],
      list,
      (database) => {
        return [
          database.slug,
          database.engine,
          database.assignments.map((assignment) => assignment.app_slug).join(
            ", ",
          ),
          Object.entries(database.safeConnectionConfig).filter(([_k, v]) => v)
            .map(([k, v]) => {
              return `${k}=${JSON.stringify(v)}`;
            }).join(" "),
        ];
      },
      (database) => {
        return {
          headers: ["NAME", "STATUS", "CREATED"],
          rows: database.databases.map((database) => {
            return [
              database.name,
              database.status,
              renderTemporalTimestamp(
                database.created_at.toISOString(),
              ),
            ];
          }),
        };
      },
    );

    await saveConfig();
  });

export const databasesDeleteCommand = new Command<DatabaseContext>()
  .description("Delete a database")
  .arguments("<name:string>")
  .action(async (options, name) => {
    const { org, saveConfig } = await ensureOrg(options, false);
    const trpcClient = createTrpcClient(options.debug, options.endpoint);

    // deno-lint-ignore no-explicit-any
    await (trpcClient.databases as any).delete.mutate({
      org: org,
      databaseInstance: name,
    });

    await saveConfig();
  });

export const databasesCommand = new Command<GlobalOptions>()
  .description("Manage databases")
  .action(() => {
    databasesCommand.showHelp();
  })
  .command("provision", databasesProvisionCommand)
  .command("link", databasesLinkCommand)
  .command("assign", databasesAssignCommand)
  .command("detach", databasesDetachCommand)
  .command("query", databasesQueryCommand)
  .command("list", databasesListCommand)
  .alias("ls")
  .command("delete", databasesDeleteCommand)
  .alias("remove")
  .alias("rm");
