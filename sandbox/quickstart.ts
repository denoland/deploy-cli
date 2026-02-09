import { Command, ValidationError } from "@cliffy/command";
import { Client, type Region, Sandbox } from "@deno/sandbox";
import { green, yellow } from "@std/fmt/colors";
import { Spinner } from "@std/cli/unstable-spinner";
import {
  type PromptEntry,
  promptSelect,
} from "@std/cli/unstable-prompt-select";
import { promptMultipleSelect } from "@std/cli/unstable-prompt-multiple-select";

import type { SandboxContext } from "./mod.ts";
import { actionHandler, getOrg } from "../config.ts";
import { getAuth } from "../auth.ts";
import { error, parseSize } from "../util.ts";

// --- Preset & Category Definitions ---
// Each preset describes a ready-made configuration: a name for the menu,
// a slug for the --preset flag, apt packages to install, and optional
// extra commands to run after installation (like pip installs).

interface Preset {
  slug: string;
  name: string;
  description: string;
  packages: string[];
  setupCommands: string[];
}

const PRESETS: Preset[] = [
  {
    slug: "python",
    name: "Python",
    description: "Python 3 with pip and venv",
    packages: ["python3", "python3-pip", "python3-venv"],
    setupCommands: [],
  },
  {
    slug: "nodejs",
    name: "Node.js",
    description: "Node.js with npm",
    packages: ["nodejs", "npm"],
    setupCommands: [],
  },
  {
    slug: "data-science",
    name: "Data Science",
    description: "Python with NumPy, Pandas, Matplotlib, SciPy",
    packages: ["python3", "python3-pip", "python3-venv"],
    setupCommands: [
      "sudo pip3 install --break-system-packages numpy pandas matplotlib scipy",
    ],
  },
  {
    slug: "web-tools",
    name: "Web Tools",
    description: "curl, wget, jq, git, headless Chromium",
    packages: ["curl", "wget", "jq", "git", "chromium"],
    setupCommands: [],
  },
  {
    slug: "system-tools",
    name: "System Tools",
    description: "build-essential, git, curl, wget, jq, sqlite3",
    packages: ["build-essential", "git", "curl", "wget", "jq", "sqlite3"],
    setupCommands: [],
  },
];

// Categories for the "Custom" flow. Each item maps a friendly label
// to the apt packages and optional setup commands it needs.

interface CategoryItem {
  label: string;
  packages: string[];
  setupCommands: string[];
}

interface Category {
  name: string;
  items: CategoryItem[];
}

const CUSTOM_CATEGORIES: Category[] = [
  {
    name: "Languages",
    items: [
      {
        label: "Python",
        packages: ["python3", "python3-pip", "python3-venv"],
        setupCommands: [],
      },
      {
        label: "Node.js",
        packages: ["nodejs", "npm"],
        setupCommands: [],
      },
    ],
  },
  {
    name: "Data & Analysis",
    items: [
      {
        label: "NumPy",
        packages: ["python3", "python3-pip"],
        setupCommands: ["sudo pip3 install --break-system-packages numpy"],
      },
      {
        label: "Pandas",
        packages: ["python3", "python3-pip"],
        setupCommands: ["sudo pip3 install --break-system-packages pandas"],
      },
      {
        label: "Matplotlib",
        packages: ["python3", "python3-pip"],
        setupCommands: ["sudo pip3 install --break-system-packages matplotlib"],
      },
      {
        label: "SciPy",
        packages: ["python3", "python3-pip"],
        setupCommands: ["sudo pip3 install --break-system-packages scipy"],
      },
    ],
  },
  {
    name: "Web & Network",
    items: [
      { label: "curl", packages: ["curl"], setupCommands: [] },
      { label: "wget", packages: ["wget"], setupCommands: [] },
      { label: "jq", packages: ["jq"], setupCommands: [] },
      { label: "git", packages: ["git"], setupCommands: [] },
      { label: "Chromium", packages: ["chromium"], setupCommands: [] },
    ],
  },
  {
    name: "System",
    items: [
      {
        label: "build-essential",
        packages: ["build-essential"],
        setupCommands: [],
      },
      { label: "sqlite3", packages: ["sqlite3"], setupCommands: [] },
      { label: "htop", packages: ["htop"], setupCommands: [] },
    ],
  },
];

// --- Interactive Prompts ---
// These functions handle the step-by-step menu the user sees
// when they run the command without flags.

function promptPresetSelection(): Preset | "custom" | null {
  const choices: PromptEntry<Preset | "custom">[] = PRESETS.map((preset) => ({
    label: `${preset.name} — ${preset.description}`,
    value: preset,
  }));

  choices.push({
    label: "Custom — Choose individual tools",
    value: "custom",
  });

  const selected = promptSelect("Select a preset:", choices, { clear: true });
  if (!selected) return null;
  return selected.value;
}

function promptCustomSelection(): {
  packages: string[];
  setupCommands: string[];
} | null {
  // Collect all selected packages and setup commands across categories.
  // We use a Set for packages so duplicates are removed automatically
  // (e.g. picking both "Python" and "NumPy" won't install python3 twice).
  const allPackages = new Set<string>();
  const allSetupCommands: string[] = [];

  for (const category of CUSTOM_CATEGORIES) {
    const choices = category.items.map((item) => ({
      label: item.label,
      value: item,
    }));

    const selected = promptMultipleSelect(
      `Select ${category.name} to install:`,
      choices,
      { clear: true },
    );

    if (selected === null) return null;

    for (const entry of selected) {
      for (const pkg of entry.value.packages) {
        allPackages.add(pkg);
      }
      for (const cmd of entry.value.setupCommands) {
        if (!allSetupCommands.includes(cmd)) {
          allSetupCommands.push(cmd);
        }
      }
    }
  }

  if (allPackages.size === 0 && allSetupCommands.length === 0) {
    return null;
  }

  return {
    packages: [...allPackages],
    setupCommands: allSetupCommands,
  };
}

function promptRegion(): Region | null {
  const choices: PromptEntry<Region>[] = [
    { label: "Chicago (ord)", value: "ord" },
    { label: "Amsterdam (ams)", value: "ams" },
  ];

  const selected = promptSelect("Select a region:", choices, { clear: true });
  if (!selected) return null;
  return selected.value;
}

function promptSnapshotName(): string | null {
  const name = prompt(
    "Enter a name for this snapshot:",
    `quickstart-${Date.now()}`,
  );
  return name;
}

// --- Build Logic ---
// This is the core of the feature. It creates a temporary volume,
// boots a sandbox, installs everything, then snapshots the result.

async function buildSnapshot(
  context: SandboxContext,
  client: Client,
  options: {
    packages: string[];
    setupCommands: string[];
    region: Region;
    snapshotSlug: string;
    capacity: number;
    token: string;
    org: string;
    verbose: boolean;
  },
): Promise<void> {
  // A unique name for the temporary volume so it doesn't clash with anything
  const volumeSlug = `qs-temp-${Date.now()}`;

  // In verbose mode, command output goes straight to the terminal.
  // In normal mode, output is hidden and we show friendly progress instead.
  const out = options.verbose ? "inherit" : "null" as const;

  const spinner = new Spinner({ color: "yellow" });

  const totalSteps = 2 + options.packages.length + options.setupCommands.length;
  let currentStep = 0;
  const step = (label: string) => {
    currentStep++;
    return `[${currentStep}/${totalSteps}]  ${label}`;
  };

  // Step 1: Create a temporary volume based on Debian 13
  spinner.message = "Creating temporary volume...";
  spinner.start();
  const volume = await client.volumes.create({
    slug: volumeSlug,
    capacity: options.capacity,
    region: options.region,
    from: "builtin:debian-13",
  });
  spinner.stop();
  console.log(`${green("✔")} Volume created`);

  let snapshotCreated = false;

  try {
    // Step 2: Boot a sandbox using this volume as its root filesystem.
    // The sandbox is short-lived (10m timeout) — just long enough to install.
    spinner.message = "Booting sandbox...";
    spinner.start();
    const sandbox = await Sandbox.create({
      token: options.token,
      org: options.org,
      timeout: "10m",
      region: options.region,
      root: volume.id,
    });
    spinner.stop();
    console.log(`${green("✔")} Sandbox booted`);

    console.log();
    console.log(
      `Installing ${options.packages.length} package${options.packages.length === 1 ? "" : "s"}` +
        (options.setupCommands.length > 0
          ? ` + ${options.setupCommands.length} setup command${options.setupCommands.length === 1 ? "" : "s"}`
          : ""),
    );
    console.log();

    try {
      // Step 3: Update the package list so apt knows what's available
      spinner.message = step("Updating package lists...");
      spinner.start();
      const updateChild = await sandbox.spawn("bash", {
        args: ["-c", "sudo apt update"],
        stdout: out,
        stderr: out,
      });
      const updateStatus = await updateChild.status;
      spinner.stop();
      if (!updateStatus.success) {
        error(context, "Failed to update package lists");
      }
      console.log(`${green("✔")} Package lists updated`);

      // Step 4: Install each apt package individually so we can show
      // per-package progress. DEBIAN_FRONTEND=noninteractive prevents
      // apt from asking questions.
      for (let i = 0; i < options.packages.length; i++) {
        const pkg = options.packages[i];
        spinner.message = step(`Installing ${pkg}...`);
        spinner.start();
        const installCmd =
          `sudo DEBIAN_FRONTEND=noninteractive apt install -y ${pkg}`;
        const installChild = await sandbox.spawn("bash", {
          args: ["-c", installCmd],
          stdout: out,
          stderr: out,
        });
        const installStatus = await installChild.status;
        spinner.stop();
        if (!installStatus.success) {
          error(context, `Failed to install ${pkg}`);
        }
        console.log(`${green("✔")} Installed ${pkg}`);
      }

      // Step 5: Run any extra setup commands (like pip installs).
      // These are optional — if one fails we warn but keep going.
      for (const cmd of options.setupCommands) {
        spinner.message = step(`Running: ${cmd}`);
        spinner.start();
        const setupChild = await sandbox.spawn("bash", {
          args: ["-c", cmd],
          stdout: out,
          stderr: out,
        });
        const setupStatus = await setupChild.status;
        spinner.stop();
        if (!setupStatus.success) {
          console.log(`${yellow("⚠")} Setup command failed: ${cmd}`);
        } else {
          console.log(`${green("✔")} ${cmd}`);
        }
      }
    } finally {
      // We must kill() the sandbox, not just close().
      // close() only disconnects the WebSocket — the sandbox keeps
      // running on the server with the volume still mounted.
      // kill() sends a DELETE to the server which actually terminates
      // the sandbox and releases the volume.
      spinner.message = "Stopping sandbox and detaching volume...";
      spinner.start();
      try {
        await sandbox.kill();
      } catch {
        // kill() may time out (10s limit), but the server is still
        // processing the termination. Wait for the WebSocket to
        // confirm the sandbox is gone.
        try {
          await Promise.race([
            sandbox.closed,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("timed out")), 30_000)
            ),
          ]);
        } catch {
          // Sandbox may have already timed out and stopped on its own
        }
      }
      // Brief pause to let the volume fully detach after sandbox termination
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      spinner.stop();
      console.log(`${green("✔")} Sandbox stopped`);
    }

    // Step 6: Snapshot the volume to create a reusable image.
    // The volume may not be fully detached from the sandbox yet,
    // so we retry a few times with increasing delays.
    const maxAttempts = 3;
    const retryDelays = [10_000, 15_000, 15_000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      spinner.message = attempt === 1
        ? "Creating snapshot..."
        : `Creating snapshot (attempt ${attempt}/${maxAttempts})...`;
      spinner.start();
      try {
        await client.volumes.snapshot(volume.id, {
          slug: options.snapshotSlug,
        });
        spinner.stop();
        console.log(`${green("✔")} Snapshot created`);
        snapshotCreated = true;
        break;
      } catch (e) {
        spinner.stop();
        if (attempt < maxAttempts) {
          const delaySec = retryDelays[attempt - 1] / 1000;
          console.log(
            `${yellow("⚠")} Snapshot attempt ${attempt} failed, retrying in ${delaySec}s...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelays[attempt - 1])
          );
        } else {
          console.log(`${yellow("⚠")} Snapshot creation failed: ${e}`);
          console.log(
            "  You can try creating it manually once the volume is ready:",
          );
          console.log(
            `  deno sandbox volumes snapshot ${volumeSlug} ${options.snapshotSlug}`,
          );
        }
      }
    }
  } finally {
    // The volume is kept because the snapshot depends on it.
    // It cannot be deleted while the snapshot exists.
  }

  if (snapshotCreated) {
    console.log();
    console.log(
      `${green("✔")} Snapshot '${options.snapshotSlug}' is ready to use.`,
    );
    console.log();
    console.log("To create a sandbox with this snapshot:");
    console.log(`  deno sandbox create --root ${options.snapshotSlug}`);
  }
}

// --- The Command ---

export const quickstartCommand = new Command<SandboxContext>()
  .description(
    "Create a pre-configured snapshot from popular tools and languages",
  )
  .option("--preset <name:string>", "Use a named preset (skip the menu)", {
    value: (name: string): string => {
      const valid = PRESETS.map((p) => p.slug);
      if (!valid.includes(name)) {
        throw new ValidationError(
          `Unknown preset '${name}'. Available presets: ${valid.join(", ")}`,
        );
      }
      return name;
    },
  })
  .option("--name <slug:string>", "Name for the snapshot")
  .option("--region <region:string>", "Region (ord or ams)")
  .option("--capacity <size:string>", "Volume capacity", { default: "10GB" })
  .option("--verbose", "Show full command output")
  .example(
    "Interactive mode",
    "quickstart",
  )
  .example(
    "Using a preset",
    "quickstart --preset python --name my-python --region ord",
  )
  .action(actionHandler(async (config, options) => {
    config.noCreate();
    const org = await getOrg(options, config, options.org);
    const token = await getAuth(options, true);

    const client = new Client({
      apiEndpoint: options.endpoint,
      token,
      org,
    });

    // Determine what to install — either from a preset flag or interactive menu
    let packages: string[];
    let setupCommands: string[];

    if (options.preset) {
      const preset = PRESETS.find((p) => p.slug === options.preset)!;
      packages = preset.packages;
      setupCommands = preset.setupCommands;
    } else {
      const selection = promptPresetSelection();
      if (selection === null) {
        error(options, "No preset was selected.");
      }

      if (selection === "custom") {
        const custom = promptCustomSelection();
        if (
          custom === null || (custom.packages.length === 0 &&
            custom.setupCommands.length === 0)
        ) {
          error(options, "No tools were selected.");
        }
        packages = custom.packages;
        setupCommands = custom.setupCommands;
      } else {
        packages = selection.packages;
        setupCommands = selection.setupCommands;
      }
    }

    // Determine region — from flag or interactive prompt
    let region: Region;
    if (options.region) {
      if (options.region !== "ord" && options.region !== "ams") {
        throw new ValidationError(
          "Region must be 'ord' (Chicago) or 'ams' (Amsterdam)",
        );
      }
      region = options.region;
    } else {
      const selected = promptRegion();
      if (selected === null) {
        error(options, "No region was selected.");
      }
      region = selected;
    }

    // Determine snapshot name — from flag or interactive prompt
    let snapshotSlug: string;
    if (options.name) {
      snapshotSlug = options.name;
    } else {
      const name = promptSnapshotName();
      if (name === null) {
        error(options, "No snapshot name was provided.");
      }
      snapshotSlug = name;
    }

    await buildSnapshot(options, client, {
      packages,
      setupCommands,
      region,
      snapshotSlug,
      capacity: Math.floor(parseSize(options, options.capacity)),
      token,
      org,
      verbose: options.verbose ?? false,
    });
  }));
