import { Command, ValidationError } from "@cliffy/command";
import { createTrpcClient } from "../auth.ts";
import { error, renderTemporalTimestamp, tablePrinter } from "../util.ts";
import type { GlobalContext } from "../main.ts";
import { parse as parseConnectionString } from "pg-connection-string";
import { actionHandler, getApp, getOrg } from "../config.ts";

export type DatabaseContext = GlobalContext & {
  org?: string;
};

const databasesProvisionCommand = new Command<DatabaseContext>()
  .description("Provision a database")
  .option("--kind <string>", "The kind of database to provision", {
    required: true,
    value: (value: string): "denokv" | "prisma" => {
      if (value !== "denokv" && value !== "prisma") {
        throw new ValidationError(
          `kind must be either "denokv" or "prisma", but got "${value}".`,
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
  .action(actionHandler(async (config, options, name) => {
    config.noCreate();

    const org = await getOrg(options, config, options.org);
    const trpcClient = createTrpcClient(options);

    if (options.kind === "prisma" && !options.region) {
      const regions = await trpcClient.query(
        "databases.prismaRegions",
        { org },
      ) as Array<{ id: string }>;

      throw new ValidationError(
        `region is required for Prisma databases.\n  Valid values are: ${
          regions.map((region) => region.id).join(", ")
        }`,
      );
    }

    await trpcClient.mutation("databases.createInstance", {
      org: org,
      slug: name,
      engine: options.kind,
      connection_config: options.kind === "denokv"
        ? {
          clientId: crypto.randomUUID(),
          region: undefined,
        }
        : {
          projectId: crypto.randomUUID(),
          region: options.region,
        },
    });
  }));

const databasesLinkCommand = new Command<DatabaseContext>()
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
  .action(actionHandler(async (config, options, name, connectionString) => {
    config.noCreate();

    const org = await getOrg(options, config, options.org);
    const trpcClient = createTrpcClient(options);

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
      await trpcClient.mutation("databases.testConnection", {
        org: org,
        engine,
        connection_config: connectionConfig,
      });
    } else {
      await trpcClient.mutation("databases.createInstance", {
        org: org,
        slug: name,
        engine,
        connectionConfig,
      });
    }
  }));

const databasesAssignCommand = new Command<DatabaseContext>()
  .description("Assign a database to an app")
  .option("--app <name:string>", "The name of the application")
  .arguments("<name:string>")
  .action(actionHandler(async (config, options, name) => {
    config.noCreate();

    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    await trpcClient.mutation("apps.assignDatabaseAttachment", {
      org,
      app,
      databaseInstance: name,
    });
  }));

const databasesDetachCommand = new Command<DatabaseContext>()
  .description("Detach a database from an app")
  .option("--app <name:string>", "The name of the application")
  .arguments("<name:string>")
  .action(actionHandler(async (config, options, name) => {
    config.noCreate();

    const org = await getOrg(options, config, options.org);
    const { app } = await getApp(options, config, false, org, options.app);
    const trpcClient = createTrpcClient(options);

    await trpcClient.mutation("apps.removeDatabaseAttachment", {
      org,
      app,
      databaseInstance: name,
    });
  }));

const databasesQueryCommand = new Command<DatabaseContext>()
  .description("Query a database")
  .arguments("<name:string> <database:string> [query...]")
  .action(
    actionHandler(async function (config, options, name, database, ...query) {
      config.noCreate();

      const org = await getOrg(options, config, options.org);
      const trpcClient = createTrpcClient(options);

      const args = this.getLiteralArgs().length > 0
        ? this.getLiteralArgs()
        : query;

      // deno-lint-ignore no-explicit-any
      const res: any = await trpcClient.mutation("databases.executeQuery", {
        org,
        databaseInstance: name,
        databaseName: database,
        query: args.join(" "),
        array: false,
      });

      if (res.kind === "ok") {
        console.log(res.rows);
      } else if (res.kind === "postgres_error") {
        error(options, res.error);
      } else if (res.error) {
        error(options, res.message);
      }
    }),
  );

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

const databasesListCommand = new Command<DatabaseContext>()
  .description("list databases")
  .arguments("[search:string]")
  .action(actionHandler(async (config, options, search) => {
    config.noCreate();

    const org = await getOrg(options, config, options.org);
    const trpcClient = createTrpcClient(options);

    const list = await trpcClient.query("databases.listInstances", {
      org: org,
      search,
    }) as Array<
      {
        slug: string;
        created_at: Date;
        databases: Array<{ name: string; status: string; created_at: Date }>;
        assignments: Array<{ app_slug: string }>;
      } & ConnectionInfo
    >;

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
  }));

const databasesDeleteCommand = new Command<DatabaseContext>()
  .description("Delete a database")
  .arguments("<name:string>")
  .action(actionHandler(async (config, options, name) => {
    config.noCreate();

    const org = await getOrg(options, config, options.org);
    const trpcClient = createTrpcClient(options);

    await trpcClient.mutation("databases.delete", {
      org,
      databaseInstance: name,
    });
  }));

export const databasesCommand = new Command<GlobalContext>()
  .description("Manage databases")
  .globalOption("--org <name:string>", "The name of the organization")
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
