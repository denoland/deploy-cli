// @ts-types="npm:@types/prompts@2.4.9"
import prompt from "npm:prompts@2.4.2";

import { gray, green, yellow } from "@std/fmt/colors";

const OIDC_PROVIDER_DOMAIN = "dev.deno-cluster.net";
const OIDC_AUDIENCE = "sts.amazonaws.com";

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

interface AwsInfo {
  Account: string;
  UserId: string;
  Arn: string;
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
    providerHasClientId = providerDetails.ClientIDList.includes(OIDC_AUDIENCE);
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

  const { policies } = await prompt({
    type: "autocompleteMultiselect",
    name: "policies",
    message: "Select permission policies you want to attach to the new role",
    choices,
    hint: "- Space to select. Return to submit",
    instructions: false,
  });
  if (policies === undefined) {
    console.log("%c   Exiting setup.", "color: yellow;");
    Deno.exit(1);
  }

  if (policies.length === 0) {
    console.log(
      "%c  No policies selected. You can attach policies later through the AWS Console.",
      "color: yellow;",
    );
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
      `   %c+ add%c the ${OIDC_AUDIENCE} client ID to the existing OIDC provider %c${providerArn}`,
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
    providerArn = await runAwsCommand<{ Arn: string }>([
      "iam",
      "create-open-id-connect-provider",
      "--url",
      `https://${OIDC_PROVIDER_DOMAIN}`,
      "--client-id-list",
      "sts.amazonaws.com",
    ]).then((res) => res.Arn);
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
    log(gray(`  Adding ${OIDC_AUDIENCE} client ID to the OIDC provider...`));
    await runAwsCommand([
      "iam",
      "add-client-id-to-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      providerArn,
      "--client-id",
      OIDC_AUDIENCE,
    ]);
    console.log(
      `\r%c✔ Added%c ${OIDC_AUDIENCE} client ID to the existing OIDC provider %c${providerArn}%c`,
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
