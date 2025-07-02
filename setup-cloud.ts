// @ts-types="npm:@types/prompts@2.4.9"
import prompt from "npm:prompts@2.4.2";

import { gray, green, yellow } from "@std/fmt/colors";

const OIDC_PROVIDER_DOMAIN = Deno.env.get("DENO_OIDC_PROVIDER_DOMAIN") ||
  "oidc.deno.com";
const AWS_OIDC_AUDIENCE = "sts.amazonaws.com";

async function runAwsCommand<T>(args: string[]): Promise<T> {
  try {
    const output = await new Deno.Command("aws", {
      args: [...args, "--output=json"],
      stdout: "piped",
      stderr: "inherit",
      stdin: "inherit",
    }).output();
    if (!output.success) Deno.exit(output.code);
    if (output.stdout.length === 0) return {} as T;
    const decoder = new TextDecoder();
    const json = decoder.decode(output.stdout);
    try {
      return JSON.parse(json) as T;
    } catch (_) {
      console.error(
        "%cError%c Failed to parse JSON output from AWS CLI command:",
        "color: red;",
        "color: reset;",
        json,
      );
      Deno.exit(1);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(
        "%cError%c AWS CLI is not installed or not found in PATH.\n\n" +
          "Please install the AWS CLI before running this command:\n" +
          "  • Visit: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html\n" +
          "color: red; font-weight: bold;",
        "color: reset;",
      );
      Deno.exit(1);
    }
    throw error;
  }
}

async function runGcloudCommand<T>(args: string[]): Promise<T> {
  try {
    const output = await new Deno.Command("gcloud", {
      args: [...args, "--format=json"],
      stdout: "piped",
      stderr: "inherit",
      stdin: "inherit",
    }).output();
    if (!output.success) Deno.exit(output.code);
    if (output.stdout.length === 0) return {} as T;
    const decoder = new TextDecoder();
    const json = decoder.decode(output.stdout);
    try {
      return JSON.parse(json) as T;
    } catch (_) {
      console.error(
        "%cError%c Failed to parse JSON output from gcloud CLI command:",
        "color: red;",
        "color: reset;",
        json,
      );
      Deno.exit(1);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(
        "%cError%c gcloud CLI is not installed or not found in PATH.\n\n" +
          "Please install the gcloud CLI before running this command:\n" +
          "  • Visit: https://cloud.google.com/sdk/docs/install\n",
        "color: red; font-weight: bold;",
        "color: reset;",
      );
      Deno.exit(1);
    }
    throw error;
  }
}

interface AwsInfo {
  Account: string;
  UserId: string;
  Arn: string;
}

interface GcpProjectInfo {
  projectId: string;
  name: string;
  projectNumber: string;
}

interface GcpService {
  config: {
    name: string;
    title: string;
  };
}

function log(string: string) {
  Deno.stdout.writeSync(new TextEncoder().encode(string));
}

export async function setupAws(org: string, app: string, contexts: string[]) {
  // Print out "AWS Setup Wizard for Deno Deploy" in an orange box
  console.log(
    "%c                                    %c\n%c  AWS Setup Wizard for Deno Deploy  %c\n%c                                    %c",
    "background-color: orange; color: black; font-weight: bold;",
    "background-color: reset; color: reset; font-weight: normal;",
    "background-color: orange; color: black; font-weight: bold;",
    "background-color: reset; color: reset; font-weight: normal;",
    "background-color: orange; color: black; font-weight: bold;",
    "background-color: reset; color: reset; font-weight: normal;",
  );
  console.log();

  // Check if AWS CLI is installed and that the user is authenticated
  log(gray("   Checking AWS account configuration..."));
  const awsInfo = await runAwsCommand<AwsInfo>([
    "sts",
    "get-caller-identity",
  ]);
  log(
    `\r${green("✔ Authenticated")} to AWS account ${
      yellow(awsInfo.Account)
    } with ${yellow(awsInfo.UserId)}\n`,
  );

  // Check whether the OIDC_PROVIDER_DOMAIN identity provider is already set up
  log(gray("  Checking OIDC provider configuration..."));
  const providers = await runAwsCommand<
    { OpenIDConnectProviderList: Array<{ Arn: string }> }
  >(["iam", "list-open-id-connect-providers"]);
  let providerArn = providers.OpenIDConnectProviderList
    .find((p) => p.Arn.includes(OIDC_PROVIDER_DOMAIN))?.Arn;
  let providerHasClientId = false;
  if (providerArn) {
    // Check that the provider has the correct client ID
    const providerDetails = await runAwsCommand<{
      ClientIDList: string[];
      Url: string;
    }>([
      "iam",
      "get-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      providerArn,
    ]);
    providerHasClientId = providerDetails.ClientIDList.includes(
      AWS_OIDC_AUDIENCE,
    );
  }

  console.log("\r                                          ");

  log(
    gray(
      "  To set up AWS with Deno Deploy, a role needs to be created that\n  can be assumed by your Deno Deploy project. This role needs to\n  be granted permissions to access AWS resources.\n\n",
    ),
  );

  log(gray("  Loading IAM policies..."));
  const allPolicies = await runAwsCommand<{
    Policies: Array<{ PolicyName: string; Arn: string }>;
  }>(["iam", "list-policies"]);
  log("\r");

  const choices = allPolicies.Policies.map((policy) => ({
    title: policy.PolicyName,
    value: policy.Arn,
  }));

  let policies;
  while (true) {
    const result = await prompt({
      type: "autocompleteMultiselect",
      name: "policies",
      message: "Select permission policies you want to attach to the new role",
      choices,
      hint: "- Space to select a policy, Enter to confirm your selections",
      instructions: false,
    });

    if (result.policies === undefined) {
      console.log("%c   Exiting setup.", "color: yellow;");
      Deno.exit(1);
    }

    if (result.policies.length === 0) {
      const { confirmNoPolicies } = await prompt({
        type: "confirm",
        name: "confirmNoPolicies",
        message:
          "Are you sure you don't want to associate any policies? Remember to use Space to select a policy, and Enter to confirm your selections.",
        initial: false,
      });
      if (!confirmNoPolicies) {
        continue;
      }
      console.log(
        "%c  No policies selected. You can attach policies later through the AWS Console.",
        "color: yellow;",
      );
    }

    policies = result.policies;
    break;
  }

  const roleName = `DenoDeploy-${org}-${app}-${
    Math.random()
      .toString(36)
      .substring(2, 8)
  }`;

  console.log(
    "\n%cThe following resources will be created or modified:\n",
    "color: gray;",
  );

  if (!providerArn) {
    console.log(
      `   %c+ create%c an OIDC provider for %chttps://${OIDC_PROVIDER_DOMAIN}`,
      "color: green;",
      "color: gray;",
      "color: blue;",
    );
  } else if (!providerHasClientId) {
    console.log(
      `   %c+ add%c the ${AWS_OIDC_AUDIENCE} client ID to the existing OIDC provider %c${providerArn}`,
      "color: green;",
      "color: gray;",
      "color: blue;",
    );
  } else {
    console.log(
      `   %c~ no modification to the existing OIDC provider %c${providerArn}`,
      "color: gray;",
      "color: blue;",
    );
  }

  console.log(
    `   %c+ create%c a new IAM role %c${roleName}%c in your AWS account`,
    "color: green;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
  );

  console.log(
    `   %c+ allow%c the role to be assumed by your Deno Deploy project %c${org}/${app}%c in ${
      contexts.length === 0 ? "%call%c " : "%c%c"
    }context${contexts.length === 1 ? "" : "s"} %c${
      new Intl.ListFormat("en-US").format(contexts)
    }%c`,
    "color: green;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
  );
  for (const policy of policies) {
    console.log(
      `   %c+ attach%c the policy %c${policy}%c to the new role`,
      "color: green;",
      "color: gray;",
      "color: blue;",
      "color: gray;",
    );
  }

  console.log("");

  const { confirm } = await prompt({
    type: "confirm",
    name: "confirm",
    message: "Do you want to apply these changes?",
    initial: true,
  });
  if (!confirm) {
    console.log("%c  Exiting setup.", "color: yellow;");
    Deno.exit(1);
  }

  if (!providerArn) {
    // If not, create it
    log(gray("  Creating the OIDC provider..."));
    providerArn = await runAwsCommand<{ OpenIDConnectProviderArn: string }>([
      "iam",
      "create-open-id-connect-provider",
      "--url",
      `https://${OIDC_PROVIDER_DOMAIN}`,
      "--client-id-list",
      "sts.amazonaws.com",
    ]).then((res) => res.OpenIDConnectProviderArn);
    console.log(
      `\r%c✔ Created%c OIDC provider for %chttps://${OIDC_PROVIDER_DOMAIN}%c with ARN: %c${providerArn}%c`,
      "color: green;",
      "color: reset;",
      "color: blue;",
      "color: reset;",
      "color: blue;",
      "color: reset;",
    );
  } else if (!providerHasClientId) {
    // If not, add it
    log(
      gray(`  Adding ${AWS_OIDC_AUDIENCE} client ID to the OIDC provider...`),
    );
    await runAwsCommand([
      "iam",
      "add-client-id-to-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      providerArn,
      "--client-id",
      AWS_OIDC_AUDIENCE,
    ]);
    console.log(
      `\r%c✔ Added%c ${AWS_OIDC_AUDIENCE} client ID to the existing OIDC provider %c${providerArn}%c`,
      "color: green;",
      "color: reset;",
      "color: blue;",
      "color: reset;",
    );
  }

  const statement = contexts.length > 0
    ? contexts.map((context) => ({
      Effect: "Allow",
      Principal: {
        Federated: providerArn,
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          [`${OIDC_PROVIDER_DOMAIN}:sub`]:
            `deployment:${org}/${app}/${context}`,
        },
      },
    }))
    : [{
      Effect: "Allow",
      Principal: {
        Federated: providerArn,
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringLike: {
          [`${OIDC_PROVIDER_DOMAIN}:sub`]: `deployment:${org}/${app}/*`,
        },
      },
    }];
  log(gray("  Creating the IAM role..."));
  const { Role } = await runAwsCommand<{ Role: { Arn: string } }>([
    "iam",
    "create-role",
    "--role-name",
    roleName,
    "--assume-role-policy-document",
    JSON.stringify({
      Version: "2012-10-17",
      Statement: statement,
    }),
    "--description",
    `Role for Deno Deploy project ${org}/${app}`,
  ]);
  log(gray("\r  Attaching policies to the role..."));
  for (const policy of policies) {
    await runAwsCommand([
      "iam",
      "attach-role-policy",
      "--role-name",
      roleName,
      "--policy-arn",
      policy,
    ]);
  }
  console.log(
    `\r%c✔ Created%c IAM role %c${roleName}%c:`,
    "color: green;",
    "color: reset;",
    "color: blue;",
    "color: reset;",
  );

  console.log("");
  console.log(`     %c${Role.Arn}%c`, "color: blue;", "color: reset;");
  console.log("");
  console.log(
    gray(
      "  Copy the role ARN above and paste it into the AWS Role ARN field during AWS integration setup in Deno Deploy.",
    ),
  );
}

export async function setupGcp(org: string, app: string, contexts: string[]) {
  // Print out "GCP Setup Wizard for Deno Deploy" in a blue box
  console.log(
    "%c                                    %c\n%c  GCP Setup Wizard for Deno Deploy  %c\n%c                                    %c",
    "background-color: blue; color: white; font-weight: bold;",
    "background-color: reset; color: reset; font-weight: normal;",
    "background-color: blue; color: white; font-weight: bold;",
    "background-color: reset; color: reset; font-weight: normal;",
    "background-color: blue; color: white; font-weight: bold;",
    "background-color: reset; color: reset; font-weight: normal;",
  );
  console.log();

  // Check if gcloud CLI is installed and that the user is authenticated
  log(gray("   Checking GCP account configuration..."));
  const accountList = await runGcloudCommand<
    Array<{ account: string; status: string }>
  >(["auth", "list", "--filter=status:ACTIVE"]);
  if (!accountList || accountList.length === 0) {
    console.error(
      "%cError%c No active GCP account found. Please run 'gcloud auth login' first.",
      "color: red; font-weight: bold;",
      "color: reset;",
    );
    Deno.exit(1);
  }
  const accountInfo = accountList[0];

  const projectId = await runGcloudCommand<string>([
    "config",
    "get-value",
    "project",
  ]);
  if (!projectId) {
    console.error(
      "%cError%c No GCP project set. Please run 'gcloud config set project PROJECT_ID' first.",
      "color: red; font-weight: bold;",
      "color: reset;",
    );
    Deno.exit(1);
  }

  // Get project details including project number
  const projectInfo = await runGcloudCommand<GcpProjectInfo>([
    "projects",
    "describe",
    projectId,
  ]);

  log(
    `\r${green("✔ Authenticated")} to GCP project ${
      yellow(projectInfo.projectId)
    } with account ${yellow(accountInfo.account)}\n`,
  );

  // Check if required APIs are enabled
  log(gray("  Checking required APIs..."));
  const requiredApis = [
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ];

  const missingApis = [];
  const services = await runGcloudCommand<
    Array<GcpService>
  >(
    [
      "services",
      "list",
      "--enabled",
      "--filter=name:(" + requiredApis.join() + ")",
    ],
  );
  const enabledApis = new Set(services.map((s) => s.config.name));
  for (const api of requiredApis) {
    if (!enabledApis.has(api)) missingApis.push(api);
  }

  if (missingApis.length > 0) {
    console.log(`\r${yellow("⚠ Missing APIs")} detected    `);
    console.log("");
    console.log("The following APIs need to be enabled:");
    for (const api of missingApis) {
      console.log(`   • ${api}`);
    }
    console.log("");

    const { enableApis } = await prompt({
      type: "confirm",
      name: "enableApis",
      message: "Do you want to enable these APIs now?",
      initial: true,
    });

    if (!enableApis) {
      console.log(
        "%c  APIs are required for GCP integration. Exiting setup.",
        "color: yellow;",
      );
      Deno.exit(1);
    }

    log(gray("  Enabling required APIs..."));
    for (const api of missingApis) {
      await runGcloudCommand([
        "services",
        "enable",
        api,
        "--no-user-output-enabled",
      ]);
    }
    console.log(`\r${green("✔ Enabled")} required APIs             `);
  } else {
    console.log(`\r${green("✔ APIs")} are enabled            `);
  }

  const gcpWorkloadIdentityId = OIDC_PROVIDER_DOMAIN.replace(/\./g, "-");

  // Check if the Workload Identity Pool already exists
  log(gray("  Checking workload identity pool..."));
  const pools = await runGcloudCommand<{ name: string; displayName: string }[]>(
    [
      "iam",
      "workload-identity-pools",
      "list",
      "--filter=name:" + gcpWorkloadIdentityId,
      "--location=global",
      "--verbosity=error",
    ],
  );
  const workloadIdentityPoolExists = pools.some((pool) =>
    pool.name.endsWith(`/` + gcpWorkloadIdentityId)
  );
  let workloadIdentityProviderExists = false;
  if (workloadIdentityPoolExists) {
    log(gray("\r  Checking workload identity provider..."));
    const providers = await runGcloudCommand<{
      name: string;
      displayName: string;
    }[]>(
      [
        "iam",
        "workload-identity-pools",
        "providers",
        "list",
        "--workload-identity-pool=" + gcpWorkloadIdentityId,
        "--location=global",
      ],
    );
    workloadIdentityProviderExists = providers.some((provider) =>
      provider.name.endsWith(`/${gcpWorkloadIdentityId}`)
    );
  }
  console.log("\r                                         ");

  log(
    gray(
      "  To set up GCP with Deno Deploy, a workload identity pool and service\n  account need to be created. The service account will be granted\n  permissions to access GCP resources.\n\n",
    ),
  );

  // List available IAM roles for selection
  log(gray("  Loading IAM roles..."));
  const roles = await runGcloudCommand<Array<{ name: string; title: string }>>(
    ["iam", "roles", "list", "--filter=stage:GA"],
  );
  log("\r");

  const roleChoices = roles.map((role) => ({
    title: `${role.title} (${role.name.split("/").pop()})`,
    value: role.name,
  }));

  let selectedRoles;
  while (true) {
    const result = await prompt({
      type: "autocompleteMultiselect",
      name: "selectedRoles",
      message: "Select IAM roles you want to grant to the service account",
      choices: roleChoices,
      hint: "- Space to select a role, Enter to confirm your selections",
      instructions: false,
    });

    if (result.selectedRoles === undefined) {
      console.log("%c   Exiting setup.", "color: yellow;");
      Deno.exit(1);
    }

    if (result.selectedRoles.length === 0) {
      const { confirmNoRoles } = await prompt({
        type: "confirm",
        name: "confirmNoRoles",
        message:
          "Are you sure you don't want to associate any roles? Remember to use Space to select a role, and Enter to confirm your selections.",
        initial: false,
      });
      if (!confirmNoRoles) {
        continue;
      }
      console.log(
        "%c  No roles selected. You can grant roles later through the GCP Console.",
        "color: yellow;",
      );
    }

    selectedRoles = result.selectedRoles;
    break;
  }

  // service account name must be between 6 and 30 characters, lowercase, and can contain letters, numbers, and dashes
  let serviceAccountName = "deno-";
  const orgPart = org.slice(0, 8).replaceAll(/-+$/g, "");
  const appPart = app.slice(0, 17 - orgPart.length).replaceAll(/-+$/g, "");
  serviceAccountName += `${orgPart}-${appPart}-${
    Math.random().toString(36).substring(2, 8)
  }`;

  const serviceAccountEmail =
    `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;

  console.log(
    "\n%cThe following resources will be created:\n",
    "color: gray;",
  );

  if (!workloadIdentityPoolExists) {
    console.log(
      `   %c+ create%c workload identity pool %c${gcpWorkloadIdentityId}`,
      "color: green;",
      "color: gray;",
      "color: blue;",
    );
  } else {
    console.log(
      `   %c~ no modification to the existing workload identity pool %c${gcpWorkloadIdentityId}`,
      "color: gray;",
      "color: blue;",
    );
  }

  if (!workloadIdentityProviderExists) {
    console.log(
      `   %c+ create%c workload identity provider %c${gcpWorkloadIdentityId}%c for %chttps://${OIDC_PROVIDER_DOMAIN}`,
      "color: green;",
      "color: gray;",
      "color: blue;",
      "color: gray;",
      "color: blue;",
    );
  } else {
    console.log(
      `   %c~ no modification to the existing workload identity provider %c${gcpWorkloadIdentityId}`,
      "color: gray;",
      "color: blue;",
    );
  }
  console.log(
    `   %c+ create%c service account %c${serviceAccountEmail}`,
    "color: green;",
    "color: gray;",
    "color: blue;",
  );

  console.log(
    `   %c+ allow%c workload identity for Deno Deploy project %c${org}/${app}%c in ${
      contexts.length === 0 ? "%call%c " : "%c%c"
    }context${contexts.length === 1 ? "" : "s"} %c${
      new Intl.ListFormat("en-US").format(contexts)
    }%c`,
    "color: green;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
    "color: blue;",
    "color: gray;",
  );

  for (const role of selectedRoles) {
    const roleName = role.split("/").pop();
    console.log(
      `   %c+ grant%c role %c${roleName}%c to the service account`,
      "color: green;",
      "color: gray;",
      "color: blue;",
      "color: gray;",
    );
  }

  console.log("");

  const { confirm } = await prompt({
    type: "confirm",
    name: "confirm",
    message: "Do you want to apply these changes?",
    initial: true,
  });

  if (!confirm) {
    console.log("%c  Exiting setup.", "color: yellow;");
    Deno.exit(1);
  }

  if (!workloadIdentityPoolExists) {
    log(gray("  Creating workload identity pool..."));
    await runGcloudCommand([
      "iam",
      "workload-identity-pools",
      "create",
      gcpWorkloadIdentityId,
      "--location=global",
      "--display-name=Deno Deploy",
      "--description=Workload Identity Pool for Deno Deploy integration",
      "--no-user-output-enabled",
    ]);
    console.log(
      `\r${
        green("✔ Created")
      } workload identity pool %c${gcpWorkloadIdentityId}`,
      "color: blue;",
    );
  }

  if (!workloadIdentityProviderExists) {
    log(gray("  Creating workload identity provider..."));
    await runGcloudCommand([
      "iam",
      "workload-identity-pools",
      "providers",
      "create-oidc",
      gcpWorkloadIdentityId,
      "--workload-identity-pool=" + gcpWorkloadIdentityId,
      "--location=global",
      "--issuer-uri=https://" + OIDC_PROVIDER_DOMAIN,
      '--attribute-mapping=google.subject=assertion.sub,attribute.org_id=assertion.org_id,attribute.org_slug=assertion.org_slug,attribute.app_id=assertion.app_id,attribute.app_slug=assertion.app_slug,attribute.full_slug=assertion.org_slug+"/"+assertion.app_slug,attribute.context_id=assertion.context_id,attribute.context_name=assertion.context_name',
      "--no-user-output-enabled",
    ]);
    console.log(
      `\r${
        green("✔ Created")
      } workload identity provider %c${gcpWorkloadIdentityId}`,
      "color: blue;",
    );
  }

  // Create service account
  log(gray("  Creating service account..."));
  await runGcloudCommand([
    "iam",
    "service-accounts",
    "create",
    serviceAccountName,
    "--display-name=" + `Deno Deploy ${org}/${app}`,
    "--description=" +
    `Service account for Deno Deploy project ${org}/${app}`,
    "--no-user-output-enabled",
  ]);
  console.log(
    `\r${green("✔ Created")} service account %c${serviceAccountEmail}`,
    "color: blue;",
  );

  // Configure workload identity binding
  log(gray("  Configuring workload identity binding..."));
  const principalSet = contexts.length > 0
    ? contexts.map((context) =>
      `principal://iam.googleapis.com/projects/${projectInfo.projectNumber}/locations/global/workloadIdentityPools/${gcpWorkloadIdentityId}/subject/deployment:${org}/${app}/${context}`
    ).join(",")
    : `principal://iam.googleapis.com/projects/${projectInfo.projectNumber}/locations/global/workloadIdentityPools/${gcpWorkloadIdentityId}/attribute.full_slug/${org}/${app}`;

  await runGcloudCommand([
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    serviceAccountEmail,
    "--role=roles/iam.workloadIdentityUser",
    "--member=" + principalSet,
    "--no-user-output-enabled",
  ]);

  // Grant selected roles to service account
  log(gray("\r  Granting roles to service account...    "));
  for (const role of selectedRoles) {
    await runGcloudCommand([
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member=serviceAccount:" + serviceAccountEmail,
      "--role=" + role,
      "--no-user-output-enabled",
    ]);
  }

  console.log(
    `\r${green("✔ Configured")} workload identity and granted roles`,
  );

  const workloadProviderId =
    `projects/${projectInfo.projectNumber}/locations/global/workloadIdentityPools/${gcpWorkloadIdentityId}/providers/${gcpWorkloadIdentityId}`;

  console.log("");
  console.log(
    "%cGCP Configuration Complete!%c",
    "color: green; font-weight: bold;",
    "color: reset;",
  );
  console.log("");
  console.log("Copy these values for Deno Deploy GCP integration setup:");
  console.log("");
  console.log(
    `%cGCP_WORKLOAD_PROVIDER_ID:%c`,
    "color: blue; font-weight: bold;",
    "color: reset;",
  );
  console.log(
    `     %c${workloadProviderId}%c`,
    "color: blue;",
    "color: reset;",
  );
  console.log("");
  console.log(
    `%cGCP_SERVICE_ACCOUNT_EMAIL:%c`,
    "color: blue; font-weight: bold;",
    "color: reset;",
  );
  console.log(
    `     %c${serviceAccountEmail}%c`,
    "color: blue;",
    "color: reset;",
  );
  console.log("");
}
