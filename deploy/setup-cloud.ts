import { promptMultipleSelect } from "@std/cli/unstable-prompt-multiple-select";

import { gray, green, yellow } from "@std/fmt/colors";
import { createTrpcClient } from "../auth.ts";
import type { GlobalContext } from "../main.ts";
import { error, ExitCode, isNonInteractive, writeJsonResult } from "../util.ts";

export interface SetupAwsOptions {
  /** AWS IAM policy ARNs to attach. When set, the interactive multi-select is skipped. */
  policies?: string[];
  /** Use this IAM role name instead of generating a random-suffixed one. Enables idempotent re-runs. */
  roleName?: string;
  /**
   * Authorize the planned cloud mutations without an interactive prompt. Required
   * to apply changes in non-interactive mode; in interactive mode it skips the
   * confirmation prompt.
   */
  apply?: boolean;
}

export interface SetupGcpOptions {
  /** GCP IAM role names to grant. When set, the interactive multi-select is skipped. */
  roles?: string[];
  /** Use this service-account name instead of generating a random-suffixed one. Enables idempotent re-runs. */
  serviceAccountName?: string;
  /** Auto-accept the API-enable prompt for any missing required APIs. */
  enableApis?: boolean;
  /**
   * Authorize the planned cloud mutations without an interactive prompt. Required
   * to apply changes in non-interactive mode; in interactive mode it skips the
   * confirmation prompt.
   */
  apply?: boolean;
}

/**
 * Decide how an infra-mutating step should be gated, given whether we're in
 * non-interactive mode and whether the caller passed an explicit opt-in flag
 * (`--apply` / `--enable-apis`). Kept pure so the safety contract is unit
 * testable without touching the cloud CLIs.
 *
 * - `"apply"`   — opt-in flag present; proceed without prompting.
 * - `"refuse"`  — non-interactive and no opt-in; the caller must abort with a
 *                 USAGE error rather than silently mutating cloud infra in CI.
 * - `"prompt"`  — interactive; ask the human for confirmation.
 */
export function applyGate(
  opts: { nonInteractive: boolean; optIn: boolean },
): "apply" | "refuse" | "prompt" {
  if (opts.optIn) return "apply";
  if (opts.nonInteractive) return "refuse";
  return "prompt";
}

/**
 * Gate the "create/modify these resources" step. Never mutates cloud infra in
 * non-interactive mode unless the caller passed `--apply`; otherwise prompts the
 * human. Exits through {@link error} (structured envelope + stable ExitCode) on
 * refusal or cancellation. Returns normally only when it's safe to proceed.
 */
function confirmApply(context: GlobalContext, apply: boolean): void {
  switch (
    applyGate({ nonInteractive: isNonInteractive(context), optIn: apply })
  ) {
    case "apply":
      return;
    case "refuse":
      error(
        context,
        "Refusing to create or modify cloud infrastructure without confirmation in non-interactive mode.",
        {
          code: ExitCode.USAGE,
          errorCode: "CONFIRMATION_REQUIRED",
          hint:
            "Re-run with --apply to authorize creating/modifying these cloud resources.",
        },
      );
      break;
    case "prompt":
      if (!confirm("Do you want to apply these changes?")) {
        error(context, "Setup cancelled. No changes were applied.", {
          code: ExitCode.USAGE,
          errorCode: "CANCELLED",
          hint: "Re-run and confirm, or pass --apply to skip the prompt.",
        });
      }
      return;
  }
}

const AWS_OIDC_AUDIENCE = "sts.amazonaws.com";

async function runAwsCommand<T>(
  context: GlobalContext,
  args: string[],
): Promise<T> {
  try {
    const output = await new Deno.Command("aws", {
      args: [...args, "--output=json"],
      stdout: "piped",
      stderr: "inherit",
      stdin: "inherit",
    }).output();
    if (!output.success) {
      error(
        context,
        `The AWS CLI command \`aws ${
          args.join(" ")
        }\` failed (exit ${output.code}).`,
        {
          code: ExitCode.GENERIC,
          errorCode: "AWS_CLI_FAILED",
          hint:
            "Check the AWS CLI output above; verify your credentials and permissions.",
        },
      );
    }
    if (output.stdout.length === 0) return {} as T;
    const decoder = new TextDecoder();
    const json = decoder.decode(output.stdout);
    try {
      return JSON.parse(json) as T;
    } catch (_) {
      error(context, "Failed to parse JSON output from the AWS CLI command.", {
        code: ExitCode.GENERIC,
        errorCode: "AWS_CLI_OUTPUT_PARSE_ERROR",
      });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      error(context, "AWS CLI is not installed or not found in PATH.", {
        code: ExitCode.USAGE,
        errorCode: "AWS_CLI_NOT_FOUND",
        hint:
          "Install the AWS CLI first: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
      });
    }
    throw err;
  }
}

async function runGcloudCommand<T>(
  context: GlobalContext,
  args: string[],
): Promise<T> {
  try {
    const output = await new Deno.Command("gcloud", {
      args: [...args, "--format=json"],
      stdout: "piped",
      stderr: "inherit",
      stdin: "inherit",
    }).output();
    if (!output.success) {
      error(
        context,
        `The gcloud CLI command \`gcloud ${
          args.join(" ")
        }\` failed (exit ${output.code}).`,
        {
          code: ExitCode.GENERIC,
          errorCode: "GCLOUD_CLI_FAILED",
          hint:
            "Check the gcloud CLI output above; verify your credentials and permissions.",
        },
      );
    }
    if (output.stdout.length === 0) return {} as T;
    const decoder = new TextDecoder();
    const json = decoder.decode(output.stdout);
    try {
      return JSON.parse(json) as T;
    } catch (_) {
      error(
        context,
        "Failed to parse JSON output from the gcloud CLI command.",
        {
          code: ExitCode.GENERIC,
          errorCode: "GCLOUD_CLI_OUTPUT_PARSE_ERROR",
        },
      );
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      error(context, "gcloud CLI is not installed or not found in PATH.", {
        code: ExitCode.USAGE,
        errorCode: "GCLOUD_CLI_NOT_FOUND",
        hint:
          "Install the gcloud CLI first: https://cloud.google.com/sdk/docs/install",
      });
    }
    throw err;
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

/** Write progress/status chrome to stderr, keeping stdout free for the result. */
function log(string: string) {
  Deno.stderr.writeSync(new TextEncoder().encode(string));
}

export async function setupAws(
  context: GlobalContext,
  org: string,
  app: string,
  contexts: string[],
  opts: SetupAwsOptions = {},
) {
  // Print out "AWS Setup Wizard for Deno Deploy" in an orange box (to stderr;
  // suppressed in JSON mode so stdout stays a clean machine channel).
  if (!context.json) {
    console.error(
      "%c                                    %c\n%c  AWS Setup Wizard for Deno Deploy  %c\n%c                                    %c",
      "background-color: orange; color: black; font-weight: bold;",
      "background-color: reset; color: reset; font-weight: normal;",
      "background-color: orange; color: black; font-weight: bold;",
      "background-color: reset; color: reset; font-weight: normal;",
      "background-color: orange; color: black; font-weight: bold;",
      "background-color: reset; color: reset; font-weight: normal;",
    );
    console.error();
  }

  const trpcClient = createTrpcClient(context);
  const { oidcHostname } = await trpcClient.query("cloudConnections.config", {
    org,
    app,
  }) as { oidcHostname: string };

  // Check if AWS CLI is installed and that the user is authenticated
  log(gray("   Checking AWS account configuration..."));
  const awsInfo = await runAwsCommand<AwsInfo>(context, [
    "sts",
    "get-caller-identity",
  ]);
  log(
    `\r${green("✔ Authenticated")} to AWS account ${
      yellow(awsInfo.Account)
    } with ${yellow(awsInfo.UserId)}\n`,
  );

  // Check whether the oidcHostname identity provider is already set up
  log(gray("  Checking OIDC provider configuration..."));
  const providers = await runAwsCommand<
    { OpenIDConnectProviderList: Array<{ Arn: string }> }
  >(context, ["iam", "list-open-id-connect-providers"]);
  let providerArn = providers.OpenIDConnectProviderList
    .find((p) => p.Arn.includes(oidcHostname))?.Arn;
  let providerHasClientId = false;
  if (providerArn) {
    // Check that the provider has the correct client ID
    const providerDetails = await runAwsCommand<{
      ClientIDList: string[];
      Url: string;
    }>(context, [
      "iam",
      "get-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      providerArn,
    ]);
    providerHasClientId = providerDetails.ClientIDList.includes(
      AWS_OIDC_AUDIENCE,
    );
  }

  console.error("\r                                          ");

  log(
    gray(
      "  To set up AWS with Deno Deploy, a role needs to be created that\n  can be assumed by your Deno Deploy project. This role needs to\n  be granted permissions to access AWS resources.\n\n",
    ),
  );

  let policies: Array<{ label: string; value: string }>;
  if (opts.policies !== undefined) {
    // Flag path: trust the caller, skip the listing and the prompt entirely.
    policies = opts.policies.map((arn) => ({ label: arn, value: arn }));
  } else if (isNonInteractive(context)) {
    error(
      context,
      "Selecting AWS policies requires interactive input.\nUse --policies <arn> (repeatable) to pre-supply policies.",
      {
        code: ExitCode.USAGE,
        errorCode: "MISSING_FLAG",
        hint: "Pass --policies <arn> for each policy you want attached.",
      },
    );
  } else {
    log(gray("  Loading IAM policies..."));
    const allPolicies = await runAwsCommand<{
      Policies: Array<{ PolicyName: string; Arn: string }>;
    }>(context, ["iam", "list-policies"]);
    log("\r");

    const choices = allPolicies.Policies.map((policy) => ({
      label: policy.PolicyName,
      value: policy.Arn,
    }));

    while (true) {
      const result = promptMultipleSelect(
        "Select permission policies you want to attach to the new role",
        choices,
        {
          clear: true,
          fitToRemainingHeight: true,
        },
      );

      if (result === null) {
        error(context, "Setup cancelled. No changes were applied.", {
          code: ExitCode.USAGE,
          errorCode: "CANCELLED",
        });
      }

      if (result.length === 0) {
        const confirmNoPolicies = confirm(
          "Are you sure you don't want to associate any policies? Remember to use Space to select a policy, and Enter to confirm your selections.",
        );
        if (!confirmNoPolicies) {
          continue;
        }
        console.error(
          "%c  No policies selected. You can attach policies later through the AWS Console.",
          "color: yellow;",
        );
      }

      policies = result;
      break;
    }
  }

  const roleName = opts.roleName ?? `DenoDeploy-${org}-${app}-${
    Math.random()
      .toString(36)
      .substring(2, 8)
  }`;

  if (!context.json) {
    console.error(
      "\n%cThe following resources will be created or modified:\n",
      "color: gray;",
    );

    if (!providerArn) {
      console.error(
        `   %c+ create%c an OIDC provider for %chttps://${oidcHostname}`,
        "color: green;",
        "color: gray;",
        "color: blue;",
      );
    } else if (!providerHasClientId) {
      console.error(
        `   %c+ add%c the ${AWS_OIDC_AUDIENCE} client ID to the existing OIDC provider %c${providerArn}`,
        "color: green;",
        "color: gray;",
        "color: blue;",
      );
    } else {
      console.error(
        `   %c~ no modification to the existing OIDC provider %c${providerArn}`,
        "color: gray;",
        "color: blue;",
      );
    }

    console.error(
      `   %c+ create%c a new IAM role %c${roleName}%c in your AWS account`,
      "color: green;",
      "color: gray;",
      "color: blue;",
      "color: gray;",
    );

    console.error(
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
      console.error(
        `   %c+ attach%c the policy %c${policy.value}%c to the new role`,
        "color: green;",
        "color: gray;",
        "color: blue;",
        "color: gray;",
      );
    }

    console.error("");
  }

  confirmApply(context, opts.apply ?? false);

  if (!providerArn) {
    // If not, create it
    log(gray("  Creating the OIDC provider..."));
    providerArn = await runAwsCommand<{ OpenIDConnectProviderArn: string }>(
      context,
      [
        "iam",
        "create-open-id-connect-provider",
        "--url",
        `https://${oidcHostname}`,
        "--client-id-list",
        "sts.amazonaws.com",
      ],
    ).then((res) => res.OpenIDConnectProviderArn);
    console.error(
      `\r%c✔ Created%c OIDC provider for %chttps://${oidcHostname}%c with ARN: %c${providerArn}%c`,
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
    await runAwsCommand(context, [
      "iam",
      "add-client-id-to-open-id-connect-provider",
      "--open-id-connect-provider-arn",
      providerArn,
      "--client-id",
      AWS_OIDC_AUDIENCE,
    ]);
    console.error(
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
          [`${oidcHostname}:sub`]: `deployment:${org}/${app}/${context}`,
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
          [`${oidcHostname}:sub`]: `deployment:${org}/${app}/*`,
        },
      },
    }];
  log(gray("  Creating the IAM role..."));
  const { Role } = await runAwsCommand<{ Role: { Arn: string } }>(context, [
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
    await runAwsCommand(context, [
      "iam",
      "attach-role-policy",
      "--role-name",
      roleName,
      "--policy-arn",
      policy.value,
    ]);
  }

  if (context.json) {
    writeJsonResult({
      provider: "aws",
      org,
      app,
      contexts,
      oidcProviderArn: providerArn,
      roleName,
      roleArn: Role.Arn,
      policies: policies.map((p) => p.value),
    });
    return;
  }

  console.error(
    `\r%c✔ Created%c IAM role %c${roleName}%c:`,
    "color: green;",
    "color: reset;",
    "color: blue;",
    "color: reset;",
  );

  console.error("");
  console.error(`     %c${Role.Arn}%c`, "color: blue;", "color: reset;");
  console.error("");
  console.error(
    gray(
      "  Copy the role ARN above and paste it into the AWS Role ARN field during AWS integration setup in Deno Deploy.",
    ),
  );
}

export async function setupGcp(
  context: GlobalContext,
  org: string,
  app: string,
  contexts: string[],
  opts: SetupGcpOptions = {},
) {
  // Print out "GCP Setup Wizard for Deno Deploy" in a blue box (to stderr;
  // suppressed in JSON mode so stdout stays a clean machine channel).
  if (!context.json) {
    console.error(
      "%c                                    %c\n%c  GCP Setup Wizard for Deno Deploy  %c\n%c                                    %c",
      "background-color: blue; color: white; font-weight: bold;",
      "background-color: reset; color: reset; font-weight: normal;",
      "background-color: blue; color: white; font-weight: bold;",
      "background-color: reset; color: reset; font-weight: normal;",
      "background-color: blue; color: white; font-weight: bold;",
      "background-color: reset; color: reset; font-weight: normal;",
    );
    console.error();
  }

  const trpcClient = createTrpcClient(context);
  const { oidcHostname } = await trpcClient.query("cloudConnections.config", {
    org,
    app,
  }) as { oidcHostname: string };

  // Check if gcloud CLI is installed and that the user is authenticated
  log(gray("   Checking GCP account configuration..."));
  const accountList = await runGcloudCommand<
    Array<{ account: string; status: string }>
  >(context, ["auth", "list", "--filter=status:ACTIVE"]);
  if (!accountList || accountList.length === 0) {
    error(context, "No active GCP account found.", {
      code: ExitCode.USAGE,
      errorCode: "GCP_NOT_AUTHENTICATED",
      hint: "Run 'gcloud auth login' first.",
    });
  }
  const accountInfo = accountList[0];

  const projectId = await runGcloudCommand<string>(context, [
    "config",
    "get-value",
    "project",
  ]);
  if (!projectId) {
    error(context, "No GCP project is set.", {
      code: ExitCode.USAGE,
      errorCode: "GCP_NO_PROJECT",
      hint: "Run 'gcloud config set project PROJECT_ID' first.",
    });
  }

  // Get project details including project number
  const projectInfo = await runGcloudCommand<GcpProjectInfo>(context, [
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
    context,
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
    console.error(`\r${yellow("⚠ Missing APIs")} detected    `);
    console.error("");
    console.error("The following APIs need to be enabled:");
    for (const api of missingApis) {
      console.error(`   • ${api}`);
    }
    console.error("");

    // Enabling APIs mutates the project, so gate it like any other apply step:
    // `--enable-apis` is the explicit non-interactive opt-in, otherwise prompt.
    switch (
      applyGate({
        nonInteractive: isNonInteractive(context),
        optIn: opts.enableApis ?? false,
      })
    ) {
      case "refuse":
        error(
          context,
          `Required GCP APIs are not enabled: ${missingApis.join(", ")}.`,
          {
            code: ExitCode.USAGE,
            errorCode: "APIS_NOT_ENABLED",
            hint:
              "Pass --enable-apis to enable the missing APIs non-interactively.",
          },
        );
        break;
      case "prompt":
        if (!confirm("Do you want to enable these APIs now?")) {
          error(
            context,
            "Required GCP APIs are not enabled. Setup cancelled.",
            {
              code: ExitCode.USAGE,
              errorCode: "CANCELLED",
              hint:
                "Re-run and accept enabling the APIs, or pass --enable-apis.",
            },
          );
        }
        break;
      case "apply":
        break;
    }

    log(gray("  Enabling required APIs..."));
    for (const api of missingApis) {
      await runGcloudCommand(context, [
        "services",
        "enable",
        api,
        "--no-user-output-enabled",
      ]);
    }
    console.error(`\r${green("✔ Enabled")} required APIs             `);
  } else {
    console.error(`\r${green("✔ APIs")} are enabled            `);
  }

  const gcpWorkloadIdentityId = oidcHostname.replace(/\./g, "-");

  // Check if the Workload Identity Pool already exists
  log(gray("  Checking workload identity pool..."));
  const pools = await runGcloudCommand<{ name: string; displayName: string }[]>(
    context,
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
      context,
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
  console.error("\r                                         ");

  log(
    gray(
      "  To set up GCP with Deno Deploy, a workload identity pool and service\n  account need to be created. The service account will be granted\n  permissions to access GCP resources.\n\n",
    ),
  );

  let selectedRoles: Array<{ label: string; value: string }>;
  if (opts.roles !== undefined) {
    selectedRoles = opts.roles.map((role) => ({ label: role, value: role }));
  } else if (isNonInteractive(context)) {
    error(
      context,
      "Selecting GCP roles requires interactive input.\nUse --roles <role> (repeatable) to pre-supply roles.",
      {
        code: ExitCode.USAGE,
        errorCode: "MISSING_FLAG",
        hint: "Pass --roles <role> for each role you want granted.",
      },
    );
  } else {
    log(gray("  Loading IAM roles..."));
    const roles = await runGcloudCommand<
      Array<{ name: string; title: string }>
    >(context, ["iam", "roles", "list", "--filter=stage:GA"]);
    log("\r");

    const roleChoices = roles.map((role) => ({
      label: `${role.title} (${role.name.split("/").pop()})`,
      value: role.name,
    }));

    while (true) {
      const result = promptMultipleSelect(
        "Select IAM roles you want to grant to the service account",
        roleChoices,
        {
          clear: true,
          fitToRemainingHeight: true,
        },
      );

      if (result === null) {
        error(context, "Setup cancelled. No changes were applied.", {
          code: ExitCode.USAGE,
          errorCode: "CANCELLED",
        });
      }

      if (result.length === 0) {
        const confirmNoRoles = confirm(
          "Are you sure you don't want to associate any roles? Remember to use Space to select a role, and Enter to confirm your selections.",
        );
        if (!confirmNoRoles) {
          continue;
        }
        console.error(
          "%c  No roles selected. You can grant roles later through the GCP Console.",
          "color: yellow;",
        );
      }

      selectedRoles = result;
      break;
    }
  }

  // Service-account name must be 6-30 chars, lowercase, [a-z0-9-]. With
  // --service-account-name we trust the caller; otherwise we derive a
  // random-suffixed default to avoid colliding with existing user resources.
  let serviceAccountName: string;
  if (opts.serviceAccountName !== undefined) {
    serviceAccountName = opts.serviceAccountName;
  } else {
    serviceAccountName = "deno-";
    const orgPart = org.slice(0, 8).replaceAll(/-+$/g, "");
    const appPart = app.slice(0, 17 - orgPart.length).replaceAll(/-+$/g, "");
    serviceAccountName += `${orgPart}-${appPart}-${
      Math.random().toString(36).substring(2, 8)
    }`;
  }

  const serviceAccountEmail =
    `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;

  if (!context.json) {
    console.error(
      "\n%cThe following resources will be created:\n",
      "color: gray;",
    );

    if (!workloadIdentityPoolExists) {
      console.error(
        `   %c+ create%c workload identity pool %c${gcpWorkloadIdentityId}`,
        "color: green;",
        "color: gray;",
        "color: blue;",
      );
    } else {
      console.error(
        `   %c~ no modification to the existing workload identity pool %c${gcpWorkloadIdentityId}`,
        "color: gray;",
        "color: blue;",
      );
    }

    if (!workloadIdentityProviderExists) {
      console.error(
        `   %c+ create%c workload identity provider %c${gcpWorkloadIdentityId}%c for %chttps://${oidcHostname}`,
        "color: green;",
        "color: gray;",
        "color: blue;",
        "color: gray;",
        "color: blue;",
      );
    } else {
      console.error(
        `   %c~ no modification to the existing workload identity provider %c${gcpWorkloadIdentityId}`,
        "color: gray;",
        "color: blue;",
      );
    }
    console.error(
      `   %c+ create%c service account %c${serviceAccountEmail}`,
      "color: green;",
      "color: gray;",
      "color: blue;",
    );

    console.error(
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
      const roleName = role.value.split("/").pop();
      console.error(
        `   %c+ grant%c role %c${roleName}%c to the service account`,
        "color: green;",
        "color: gray;",
        "color: blue;",
        "color: gray;",
      );
    }

    console.error("");
  }

  confirmApply(context, opts.apply ?? false);

  if (!workloadIdentityPoolExists) {
    log(gray("  Creating workload identity pool..."));
    await runGcloudCommand(context, [
      "iam",
      "workload-identity-pools",
      "create",
      gcpWorkloadIdentityId,
      "--location=global",
      "--display-name=Deno Deploy",
      "--description=Workload Identity Pool for Deno Deploy integration",
      "--no-user-output-enabled",
    ]);
    console.error(
      `\r${
        green("✔ Created")
      } workload identity pool %c${gcpWorkloadIdentityId}`,
      "color: blue;",
    );
  }

  if (!workloadIdentityProviderExists) {
    log(gray("  Creating workload identity provider..."));
    await runGcloudCommand(context, [
      "iam",
      "workload-identity-pools",
      "providers",
      "create-oidc",
      gcpWorkloadIdentityId,
      "--workload-identity-pool=" + gcpWorkloadIdentityId,
      "--location=global",
      "--issuer-uri=https://" + oidcHostname,
      '--attribute-mapping=google.subject=assertion.sub,attribute.org_id=assertion.org_id,attribute.org_slug=assertion.org_slug,attribute.app_id=assertion.app_id,attribute.app_slug=assertion.app_slug,attribute.full_slug=assertion.org_slug+"/"+assertion.app_slug,attribute.context_id=assertion.context_id,attribute.context_name=assertion.context_name',
      "--no-user-output-enabled",
    ]);
    console.error(
      `\r${
        green("✔ Created")
      } workload identity provider %c${gcpWorkloadIdentityId}`,
      "color: blue;",
    );
  }

  // Create service account
  log(gray("  Creating service account..."));
  await runGcloudCommand(context, [
    "iam",
    "service-accounts",
    "create",
    serviceAccountName,
    "--display-name=" + `Deno Deploy ${org}/${app}`,
    "--description=" +
    `Service account for Deno Deploy project ${org}/${app}`,
    "--no-user-output-enabled",
  ]);
  console.error(
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

  await runGcloudCommand(context, [
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
    await runGcloudCommand(context, [
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member=serviceAccount:" + serviceAccountEmail,
      "--role=" + role.value,
      "--no-user-output-enabled",
    ]);
  }

  console.error(
    `\r${green("✔ Configured")} workload identity and granted roles`,
  );

  const workloadProviderId =
    `projects/${projectInfo.projectNumber}/locations/global/workloadIdentityPools/${gcpWorkloadIdentityId}/providers/${gcpWorkloadIdentityId}`;

  if (context.json) {
    writeJsonResult({
      provider: "gcp",
      org,
      app,
      contexts,
      projectId,
      serviceAccountEmail,
      workloadIdentityPoolId: gcpWorkloadIdentityId,
      workloadProviderId,
      roles: selectedRoles.map((r) => r.value),
      enabledApis: missingApis,
    });
    return;
  }

  console.error("");
  console.error(
    "%cGCP Configuration Complete!%c",
    "color: green; font-weight: bold;",
    "color: reset;",
  );
  console.error("");
  console.error("Copy these values for Deno Deploy GCP integration setup:");
  console.error("");
  console.error(
    `%cGCP_WORKLOAD_PROVIDER_ID:%c`,
    "color: blue; font-weight: bold;",
    "color: reset;",
  );
  console.error(
    `     %c${workloadProviderId}%c`,
    "color: blue;",
    "color: reset;",
  );
  console.error("");
  console.error(
    `%cGCP_SERVICE_ACCOUNT_EMAIL:%c`,
    "color: blue; font-weight: bold;",
    "color: reset;",
  );
  console.error(
    `     %c${serviceAccountEmail}%c`,
    "color: blue;",
    "color: reset;",
  );
  console.error("");
}
