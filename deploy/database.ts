import { Command, ValidationError } from "@cliffy/command";
import { createTrpcClient } from "../auth.ts";
import {
  error,
  jsonOutput,
  renderTemporalTimestamp,
  tablePrinter,
} from "../util.ts";
import { green } from "@std/fmt/colors";
import type { GlobalContext } from "../main.ts";
import { parse as parseConnectionString } from "pg-connection-string";
import { actionHandler, getApp, getOrg } from "../config.ts";

export type DatabaseContext = GlobalContext & {
  org?: string;
};

const databasesProvisionCommand = new Command<DatabaseContext>()
  .description("Provision a database")
  .example("Provision a Deno KV database", "provision my-db --kind denokv")
  .example(
    "Provision a Prisma database",
    "provision my-db --kind prisma --region us-east-1",
  )
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

    if (options.json) {
      jsonOutput({ ok: true, name, engine: options.kind });
    } else {
      console.log(
        `${
          green("✔")
        } Successfully provisioned ${options.kind} database '${name}'.`,
      );
    }
  }));

const databasesLinkCommand = new Command<DatabaseContext>()
  .description("Link a database")
  .example(
    "Link with a connection string",
    "link my-db postgres://user:pass@host/db",
  )
  .example(
    "Test connection without linking",
    "link --dry-run my-db --hostname db.example.com",
  )
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
        !connectionString.startsWith("postgres://") &&
        !connectionString.startsWith("postgresql://")
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
      if (options.json) {
        jsonOutput({ ok: true, action: "test", name });
      } else {
        console.log(`${green("✔")} Connection test successful.`);
      }
    } else {
      await trpcClient.mutation("databases.createInstance", {
        org: org,
        slug: name,
        engine,
        connectionConfig,
      });
      if (options.json) {
        jsonOutput({ ok: true, action: "linked", name, engine });
      } else {
        console.log(`${green("✔")} Successfully linked database '${name}'.`);
      }
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

    if (options.json) {
      jsonOutput({ ok: true, action: "assigned", database: name, app });
    } else {
      console.log(
        `${
          green("✔")
        } Successfully assigned database '${name}' to app '${app}'.`,
      );
    }
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

    if (options.json) {
      jsonOutput({ ok: true, action: "detached", database: name, app });
    } else {
      console.log(
        `${
          green("✔")
        } Successfully detached database '${name}' from app '${app}'.`,
      );
    }
  }));

const databasesQueryCommand = new Command<DatabaseContext>()
  .description("Query a database")
  .example(
    "Run a query",
    "query my-db postgres -- SELECT * FROM users LIMIT 10",
  )
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
        if (options.json) {
          jsonOutput(res.rows);
        } else if (
          Array.isArray(res.rows) && res.rows.length > 0 &&
          typeof res.rows[0] === "object" && res.rows[0] !== null
        ) {
          const keys = Object.keys(res.rows[0]);
          tablePrinter(
            keys.map((k) => k.toUpperCase()),
            res.rows,
            (row: Record<string, unknown>) =>
              keys.map((k) => String(row[k] ?? "")),
          );
        } else if (Array.isArray(res.rows) && res.rows.length === 0) {
          console.log("No rows returned.");
        } else {
          console.log(res.rows);
        }
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
  .description("List databases")
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

    if (options.json) {
      jsonOutput(list.map((db) => ({
        name: db.slug,
        engine: db.engine,
        createdAt: db.created_at,
        assignments: db.assignments.map((a) => a.app_slug),
        connectionConfig: db.safeConnectionConfig,
        databases: db.databases.map((d) => ({
          name: d.name,
          status: d.status,
          createdAt: d.created_at,
        })),
      })));
      return;
    }

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

    if (options.json) {
      jsonOutput({ ok: true, action: "deleted", database: name });
    } else {
      console.log(`${green("✔")} Successfully deleted database '${name}'.`);
    }
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
