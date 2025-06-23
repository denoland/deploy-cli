import { red } from "@std/fmt/colors";
import { promptSelect } from "@std/cli/unstable-prompt-select";

import { createTrpcClient, getAuth } from "./auth.ts";

export function error(error: string, response?: Response): never {
  console.error(`${red("✗")} An error occurred:`);
  console.error(`  ${error.replaceAll("\n", "\n  ")}`);
  const trace = response?.headers.get("x-deno-trace-id");
  if (trace) {
    console.error(`  trace id: ${trace}`);
  }
  Deno.exit(1);
}

export async function withApp(
  org?: string,
  app?: string | null,
): Promise<{ org: string; app: string | null }> {
  await getAuth();

  const trpcClient = await createTrpcClient();

  if (!org || !app) {
    const orgs: Array<{
      name: string;
      slug: string;
      id: string;
      // deno-lint-ignore no-explicit-any
    }> = await (trpcClient.orgs as any).list.query();

    const orgStrings = orgs.map((org) => `${org.name} (${org.slug})`);
    const orgsResult = promptSelect("Select an organization:", orgStrings, {
      clear: true,
    });
    if (!orgsResult) {
      console.error("No organization was selected.");
      Deno.exit(1);
    }

    const selectedOrg = orgs[orgStrings.indexOf(orgsResult)];
    org = selectedOrg.slug;
    console.log(`Selected organization '${selectedOrg.name}'`);

    const apps: Array<{ name: string; slug: string }> =
      // deno-lint-ignore no-explicit-any
      await (trpcClient.apps as any)
        .list.query({
          org: selectedOrg.id,
        });
    const appStrings = apps.map((app) => `${app.slug}`);
    appStrings.push("Create a new app");
    const appsResult = promptSelect("Select an application:", appStrings, {
      clear: true,
    });
    if (!appsResult) {
      console.error("No application was selected.");
      Deno.exit(1);
    }

    const index = appStrings.indexOf(appsResult);

    if (index == (appStrings.length - 1)) {
      app = null;
    } else {
      const selectedApp = apps[appStrings.indexOf(appsResult)];
      app = selectedApp.slug;
      console.log(`Selected app '${selectedApp.slug}'`);
    }
  }

  if (org === undefined) {
    console.error(
      "Expected 'deploy.org' in the config file or the '--org' flag to be specified.",
    );
    Deno.exit(1);
  }
  if (app === undefined) {
    console.error(
      "Expected 'deploy.app' in the config file or the '--app' flag to be specified.",
    );
    Deno.exit(1);
  }

  return {
    org,
    app,
  };
}
