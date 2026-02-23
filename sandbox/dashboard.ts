import { Command } from "@cliffy/command";
import {
  bold,
  cyan,
  dim,
  green,
  red,
  stripAnsiCode,
  yellow,
} from "@std/fmt/colors";
import { Sandbox } from "@deno/sandbox";

import { formatDuration, renderTemporalTimestamp } from "../util.ts";
import { createTrpcClient, getAuth } from "../auth.ts";
import { actionHandler, getOrg } from "../config.ts";
import type { SandboxContext } from "./mod.ts";

// --- Types ---

interface SandboxInfo {
  id: string;
  status: "running" | "stopped";
  created_at: Date;
  stopped_at: Date | null;
  cluster_hostname: string;
}

interface OrgInfo {
  name: string;
  slug: string;
  id: string;
}

interface DashboardState {
  sandboxes: SandboxInfo[];
  selectedIndex: number;
  org: string;
  error: string | null;
  loading: boolean;
  lastRefresh: Date;
  regionFilter: string | null;
  sortBy: "created" | "status" | "region";
  sortAsc: boolean;
  mode: "normal" | "extend" | "org";
  statusMessage: string | null;
  orgs: OrgInfo[];
  orgSelectedIndex: number;
}

// --- ANSI escape helpers ---

// These are special character sequences that tell the terminal what to do.
// For example, ESC[H moves the cursor to the top-left corner of the screen.
const ESC = "\x1b";
const CLEAR_SCREEN = `${ESC}[2J`;
const CURSOR_HOME = `${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const RESET_STYLE = `${ESC}[0m`;
const INVERSE = `${ESC}[7m`;

// --- API functions ---

// Fetches the list of sandboxes from the API.
// Wrapped in try/catch so errors don't crash the dashboard —
// instead we store the error message and keep showing stale data.
async function fetchSandboxes(
  client: ReturnType<typeof createTrpcClient>,
  org: string,
): Promise<{ sandboxes: SandboxInfo[]; error: string | null }> {
  try {
    const list = await client.query("sandboxes.list", { org }) as SandboxInfo[];
    return { sandboxes: list, error: null };
  } catch (e) {
    return { sandboxes: [], error: (e as Error).message };
  }
}

// Kills a sandbox by first looking up its hostname, then calling the kill mutation.
// This is the same two-step pattern used by the `sandbox kill` command.
async function killSandbox(
  client: ReturnType<typeof createTrpcClient>,
  org: string,
  sandboxId: string,
): Promise<{ success: boolean; error: string | null }> {
  try {
    const cluster = await client.query("sandboxes.findHostname", {
      org,
      sandboxId,
    }) as { hostname: string };

    const res = await client.mutation("sandboxes.kill", {
      org,
      sandboxId,
      clusterHostname: cluster.hostname,
    }) as { success: boolean };

    return { success: res.success, error: null };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// --- Screen rendering ---

// Builds the entire screen as one big string, then writes it all at once.
// Writing everything in a single shot prevents flickering — the terminal
// doesn't show partial updates between frames.
function renderScreen(state: DashboardState): string {
  const { columns, rows } = Deno.consoleSize();
  const lines: string[] = [];

  // Apply region filter and sort to get the display list.
  // We work on a copy so we don't mutate the original state.
  const filtered = getFilteredSandboxes(state);
  const displayList = sortSandboxes(filtered, state.sortBy, state.sortAsc);

  // Header
  const title = bold(cyan(" Sandbox Dashboard"));
  const orgLabel = yellow(`Org: ${state.org}`);
  const headerPadding = columns - stripAnsiCode(title).length -
    stripAnsiCode(orgLabel).length;
  lines.push(title + " ".repeat(Math.max(1, headerPadding)) + orgLabel);

  // Status summary — shows total count, running/stopped breakdown,
  // current filter and sort
  const total = state.sandboxes.length;
  const running = state.sandboxes.filter((s) => s.status === "running").length;
  const stopped = state.sandboxes.filter((s) => s.status === "stopped").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (stopped > 0) parts.push(`${stopped} stopped`);

  let summary = ` ${total} total`;
  if (parts.length > 0) summary += ` — ${parts.join(", ")}`;
  if (state.regionFilter) summary += dim(` (region: ${state.regionFilter})`);
  const sortArrow = state.sortAsc ? "↑" : "↓";
  summary += dim(`  Sort: ${state.sortBy} ${sortArrow}`);

  const timeStr = dim(
    `Last refresh: ${
      state.lastRefresh.toLocaleTimeString("en-US", { hour12: false })
    }`,
  );
  const summaryPadding = columns - stripAnsiCode(summary).length -
    stripAnsiCode(timeStr).length;
  lines.push(summary + " ".repeat(Math.max(1, summaryPadding)) + timeStr);

  lines.push(dim("─".repeat(columns)));

  // How many rows are available for list items (sandboxes or orgs)?
  // We subtract: header (3 lines above), table/org header (1 line), footer (2 lines).
  // This keeps header + footer fixed and only the list rows scroll.
  const maxVisibleRows = rows - 3 - 1 - 2;

  if (state.mode === "org") {
    // Org picker — replaces the sandbox table when choosing an org
    lines.push(bold(cyan(" Select Organization")));
    lines.push(dim("  " + "NAME".padEnd(30) + "  " + "SLUG"));

    const { start, end } = getVisibleRange(
      state.orgs.length,
      state.orgSelectedIndex,
      maxVisibleRows - 1,
    );

    for (let i = start; i < end; i++) {
      const org = state.orgs[i];
      const isHighlighted = i === state.orgSelectedIndex;
      const isActive = org.slug === state.org;
      const marker = isHighlighted ? ">" : " ";
      const activeMarker = isActive ? " " + green("●") : "";

      const row = ` ${marker} ${org.name.padEnd(30)}  ${
        dim(org.slug)
      }${activeMarker}`;

      if (isHighlighted) {
        lines.push(INVERSE + row + RESET_STYLE);
      } else {
        lines.push(row);
      }
    }

    if (state.orgs.length > maxVisibleRows) {
      const parts: string[] = [];
      if (start > 0) parts.push(dim("▲ more above"));
      parts.push(yellow(`[${start + 1}–${end} of ${state.orgs.length}]`));
      if (end < state.orgs.length) parts.push(dim("▼ more below"));
      lines.push("  " + parts.join("  "));
    }
  } else {
    // Normal sandbox table
    const headers = ["", "ID", "REGION", "STATUS", "UPTIME", "CREATED"];
    const colWidths = [2, 16, 10, 10, 10, 22];

    // Calculate column widths based on actual data
    for (const sandbox of displayList) {
      colWidths[1] = Math.max(colWidths[1], sandbox.id.length);
      const region = sandbox.cluster_hostname.split(".")[0];
      colWidths[2] = Math.max(colWidths[2], region.length);
    }

    const headerLine = " " + headers.map((h, i) =>
      dim(h.padEnd(colWidths[i]))
    ).join("  ");
    lines.push(headerLine);

    // Sandbox rows — render the filtered+sorted list
    if (displayList.length === 0 && !state.loading) {
      lines.push("");
      if (state.regionFilter) {
        lines.push(
          dim(
            `  No sandboxes in region "${state.regionFilter}". Press f to cycle filters.`,
          ),
        );
      } else {
        lines.push(
          dim("  No sandboxes found. Create one with: deno sandbox new"),
        );
      }
    } else {
      // Only render the rows that fit on screen, scrolling to keep the
      // selected item visible. The header and footer stay fixed.
      const { start, end } = getVisibleRange(
        displayList.length,
        state.selectedIndex,
        maxVisibleRows,
      );

      for (let i = start; i < end; i++) {
        const sandbox = displayList[i];
        const isSelected = i === state.selectedIndex;

        let duration;
        if (sandbox.stopped_at) {
          duration = new Date(sandbox.stopped_at).getTime() -
            new Date(sandbox.created_at).getTime();
        } else {
          duration = Date.now() - new Date(sandbox.created_at).getTime();
        }

        const marker = isSelected ? ">" : " ";
        const region = sandbox.cluster_hostname.split(".")[0];
        const statusText = sandbox.status === "running"
          ? green("● running")
          : red("○ stopped");
        const uptime = formatDuration(duration);
        const created = renderTemporalTimestamp(
          new Date(sandbox.created_at).toISOString(),
        );

        // stripAnsiCode is needed because color codes add invisible characters
        // that would mess up the padding math.
        const statusPadded = statusText +
          " ".repeat(
            Math.max(0, colWidths[3] - stripAnsiCode(statusText).length),
          );

        const row = ` ${marker} ${sandbox.id.padEnd(colWidths[1])}  ` +
          `${region.padEnd(colWidths[2])}  ` +
          `${statusPadded}  ` +
          `${uptime.padEnd(colWidths[4])}  ` +
          `${created}`;

        if (isSelected) {
          lines.push(INVERSE + row + RESET_STYLE);
        } else {
          lines.push(row);
        }
      }

      // Show scroll indicators when the list doesn't fit on one screen.
      // ▲/▼ arrows only appear when there's content in that direction.
      if (displayList.length > maxVisibleRows) {
        const parts: string[] = [];
        if (start > 0) parts.push(dim("▲ more above"));
        parts.push(yellow(`[${start + 1}–${end} of ${displayList.length}]`));
        if (end < displayList.length) parts.push(dim("▼ more below"));
        lines.push("  " + parts.join("  "));
      }
    }
  }

  // Fill remaining space so the footer stays at the bottom
  const footerHeight = 2;
  const usedLines = lines.length;
  const availableLines = rows - footerHeight;
  for (let i = usedLines; i < availableLines; i++) {
    lines.push("");
  }

  // Footer — status messages and shortcut bar
  if (state.mode === "extend") {
    lines.push(
      bold(" Extend by: ") + "1) 5m  2) 15m  3) 30m  4) 1h  " +
        dim("(Esc cancel)"),
    );
  } else if (state.mode === "org") {
    lines.push(
      bold(" Select org: ") + dim("↑/↓ Navigate  Enter Select  Esc Cancel"),
    );
  } else if (state.error) {
    lines.push(red(` ✗ Error: ${state.error}`));
  } else if (state.statusMessage) {
    lines.push(green(` ✓ ${state.statusMessage}`));
  } else if (state.loading) {
    lines.push(dim(" Refreshing..."));
  } else {
    lines.push("");
  }

  const shortcuts = state.mode === "org"
    ? " " + green("●") + dim(" = active org")
    : " " + [
      bold("↑/↓") + dim(" Navigate"),
      bold("s") + dim(" SSH"),
      bold("k") + dim(" Kill"),
      bold("e") + dim(" Extend"),
      bold("c") + dim(" Copy ID"),
      bold("f") + dim(" Filter"),
      bold("o/O") + dim(" Sort"),
      bold("t") + dim(" Org"),
      bold("r") + dim(" Refresh"),
      bold("q") + dim(" Quit"),
    ].join("  ");
  lines.push(shortcuts);

  return CLEAR_SCREEN + CURSOR_HOME + lines.join("\n");
}

// Sorts a list of sandboxes based on the current sort column.
// Returns a new array — doesn't modify the original.
function sortSandboxes(
  sandboxes: SandboxInfo[],
  sortBy: "created" | "status" | "region",
  asc: boolean,
): SandboxInfo[] {
  const sorted = [...sandboxes];
  switch (sortBy) {
    case "created":
      // Newest first
      sorted.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      break;
    case "status":
      // Running first, then stopped
      sorted.sort((a, b) => {
        if (a.status === b.status) return 0;
        return a.status === "running" ? -1 : 1;
      });
      break;
    case "region":
      // Alphabetical by region name
      sorted.sort((a, b) =>
        a.cluster_hostname.split(".")[0].localeCompare(
          b.cluster_hostname.split(".")[0],
        )
      );
      break;
  }
  if (asc) sorted.reverse();
  return sorted;
}

// --- Keypress reading ---

// Reads individual keypresses from the terminal by putting stdin into "raw" mode.
// Normally the terminal waits for you to press Enter before sending input.
// Raw mode sends each keypress immediately, which is how we detect arrow keys.
// Arrow keys are sent as 3-byte sequences: ESC [ A (up), ESC [ B (down), etc.
async function* readKeypress(): AsyncGenerator<string> {
  const buf = new Uint8Array(8);
  const reader = Deno.stdin.readable.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;

      // Copy the bytes we received into our buffer
      buf.set(value);
      const len = value.length;

      if (len === 1) {
        // Single byte keypresses
        const byte = buf[0];
        if (byte === 0x03) yield "ctrl+c"; // Ctrl+C
        else if (byte === 0x1b) yield "escape"; // Escape (single byte, not arrow)
        else if (byte === 0x71) yield "q";
        else if (byte === 0x6b) yield "k";
        else if (byte === 0x72) yield "r";
        else if (byte === 0x73) yield "s"; // SSH
        else if (byte === 0x65) yield "e"; // Extend
        else if (byte === 0x66) yield "f"; // Filter
        else if (byte === 0x6f) yield "o"; // Order/sort
        else if (byte === 0x4f) yield "O"; // Toggle sort direction
        else if (byte === 0x63) yield "c"; // Copy
        else if (byte === 0x74) yield "t"; // Team/org picker
        else if (byte === 0x0d) yield "enter"; // Enter/Return
        else if (byte === 0x31) yield "1"; // Extend presets
        else if (byte === 0x32) yield "2";
        else if (byte === 0x33) yield "3";
        else if (byte === 0x34) yield "4";
      } else if (len === 3 && buf[0] === 0x1b && buf[1] === 0x5b) {
        // Arrow key escape sequences: ESC [ A/B/C/D
        if (buf[2] === 0x41) yield "up";
        if (buf[2] === 0x42) yield "down";
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// --- Helper functions ---

// Returns the list of sandboxes after applying the region filter.
// Used by both the key handlers (for navigation bounds) and renderScreen.
function getFilteredSandboxes(state: DashboardState): SandboxInfo[] {
  if (state.regionFilter === null) return state.sandboxes;
  return state.sandboxes.filter(
    (s) => s.cluster_hostname.split(".")[0] === state.regionFilter,
  );
}

// Gets the sandbox that's currently highlighted, accounting for the region filter.
function getSelectedSandbox(state: DashboardState): SandboxInfo | undefined {
  const filtered = getFilteredSandboxes(state);
  return filtered[state.selectedIndex];
}

// Figures out which slice of a list to display so the selected item stays visible.
// Think of it like a window sliding over the full list — the window moves to
// follow the cursor, but the header and footer stay fixed on screen.
function getVisibleRange(
  totalItems: number,
  selectedIndex: number,
  maxVisible: number,
): { start: number; end: number } {
  // If everything fits, show it all
  if (totalItems <= maxVisible) {
    return { start: 0, end: totalItems };
  }

  // Center the selected item in the visible window when possible.
  // If the selected item is near the top or bottom of the list,
  // the window clamps to the edges so we don't show empty space.
  let start = selectedIndex - Math.floor(maxVisible / 2);
  start = Math.max(0, start);
  start = Math.min(start, totalItems - maxVisible);

  return { start, end: start + maxVisible };
}

// Copies text to the system clipboard using platform-specific commands.
// macOS uses pbcopy, Linux tries xclip first then falls back to xsel.
async function copyToClipboard(text: string): Promise<void> {
  const os = Deno.build.os;
  let cmd: string[];

  if (os === "darwin") {
    cmd = ["pbcopy"];
  } else if (os === "linux") {
    cmd = ["xclip", "-selection", "clipboard"];
  } else {
    throw new Error("Clipboard not supported on this platform");
  }

  const process = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "piped",
  }).spawn();

  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  const result = await process.output();

  if (!result.success) {
    // On Linux, try xsel as fallback
    if (os === "linux") {
      const fallback = new Deno.Command("xsel", {
        args: ["--clipboard", "--input"],
        stdin: "piped",
      }).spawn();
      const fbWriter = fallback.stdin.getWriter();
      await fbWriter.write(new TextEncoder().encode(text));
      await fbWriter.close();
      const fbResult = await fallback.output();
      if (!fbResult.success) {
        throw new Error("No clipboard tool available (tried xclip and xsel)");
      }
    } else {
      throw new Error("Clipboard command failed");
    }
  }
}

// --- Terminal cleanup ---

// Restores the terminal to its normal state. This is critical —
// if we crash without doing this, the user's terminal would be stuck
// in raw mode with no visible cursor, which is very confusing.
// We call this on quit, Ctrl+C, and in a finally block as a safety net.
function restoreTerminal() {
  const encoder = new TextEncoder();
  Deno.stdout.writeSync(encoder.encode(SHOW_CURSOR + RESET_STYLE));
  try {
    Deno.stdin.setRaw(false);
  } catch {
    // stdin may already be restored or not a TTY
  }
}

// --- Main dashboard loop ---

// This is the heart of the dashboard. It:
// 1. Fetches sandbox data from the API
// 2. Renders the screen
// 3. Waits for a keypress OR the auto-refresh timer
// 4. Updates the state based on what happened
// 5. Re-renders and loops back to step 3
async function runDashboard(
  client: ReturnType<typeof createTrpcClient>,
  org: string,
  options: SandboxContext,
) {
  const encoder = new TextEncoder();

  const state: DashboardState = {
    sandboxes: [],
    selectedIndex: 0,
    org,
    error: null,
    loading: true,
    lastRefresh: new Date(),
    regionFilter: null,
    sortBy: "created",
    sortAsc: false,
    mode: "normal",
    statusMessage: null,
    orgs: [],
    orgSelectedIndex: 0,
  };

  // Initial data fetch
  const initial = await fetchSandboxes(client, org);
  state.sandboxes = initial.sandboxes;
  state.error = initial.error;
  state.loading = false;
  state.lastRefresh = new Date();

  // Fetch available orgs for the org picker
  try {
    state.orgs = await client.query("orgs.list") as OrgInfo[];
  } catch {
    // If we can't fetch orgs, the picker just won't be available
  }

  // Enter raw mode so we can read individual keypresses
  Deno.stdin.setRaw(true);
  Deno.stdout.writeSync(encoder.encode(HIDE_CURSOR));

  // Draw the initial screen
  Deno.stdout.writeSync(encoder.encode(renderScreen(state)));

  // Auto-refresh timer — fires every 5 seconds to fetch fresh data
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  // This function refreshes the data and redraws the screen.
  // Used by both the timer and the manual refresh (r key).
  const refreshAndRender = async () => {
    state.loading = true;
    Deno.stdout.writeSync(encoder.encode(renderScreen(state)));

    const result = await fetchSandboxes(client, state.org);
    if (result.error) {
      // Show error but keep stale data visible
      state.error = result.error;
    } else {
      state.sandboxes = result.sandboxes;
      state.error = null;
    }
    state.loading = false;
    state.lastRefresh = new Date();

    // Clamp selection to the filtered list length
    // (sandboxes may have appeared or disappeared)
    const filtered = getFilteredSandboxes(state);
    if (filtered.length > 0) {
      state.selectedIndex = Math.min(
        state.selectedIndex,
        filtered.length - 1,
      );
    } else {
      state.selectedIndex = 0;
    }

    Deno.stdout.writeSync(encoder.encode(renderScreen(state)));
  };

  refreshTimer = setInterval(refreshAndRender, 5000);

  // Re-render on terminal resize so the layout adapts
  const resizeHandler = () => {
    Deno.stdout.writeSync(encoder.encode(renderScreen(state)));
  };
  Deno.addSignalListener("SIGWINCH", resizeHandler);

  // Tracks when we need to break out of the keypress loop for SSH
  let sshTarget: string | null = null;
  let shouldQuit = false;

  try {
    // Outer loop — allows re-entering the keypress reader after SSH sessions.
    // SSH needs to take over stdin completely, so we break the inner loop
    // (which releases the reader lock), do SSH, then start reading again.
    while (!shouldQuit) {
      // Main input loop — reads keypresses one at a time
      for await (const key of readKeypress()) {
        if (key === "q" || key === "ctrl+c") {
          shouldQuit = true;
          break;
        }

        // When we're in extend mode, only accept 1-4 or Esc
        if (state.mode === "extend") {
          const durations: Record<string, `${number}m`> = {
            "1": "5m",
            "2": "15m",
            "3": "30m",
            "4": "60m",
          };
          const durationLabels: Record<string, string> = {
            "1": "5m",
            "2": "15m",
            "3": "30m",
            "4": "1h",
          };
          if (key in durations) {
            const selected = getSelectedSandbox(state);
            if (selected && selected.status === "running") {
              try {
                const token = await getAuth(options, true);
                await using sandbox = await Sandbox.connect({
                  id: selected.id,
                  apiEndpoint: options.endpoint,
                  debug: options.debug,
                  token,
                  org,
                });
                await sandbox.extendTimeout(durations[key]);
                state.statusMessage =
                  `Extended timeout by ${durationLabels[key]}`;
              } catch (e) {
                state.error = (e as Error).message;
              }
              await refreshAndRender();
            }
          }
          state.mode = "normal";
          Deno.stdout.writeSync(encoder.encode(renderScreen(state)));
          continue;
        }

        // When we're in org mode, only accept ↑/↓/Enter/Esc
        if (state.mode === "org") {
          if (key === "up") {
            if (state.orgSelectedIndex > 0) {
              state.orgSelectedIndex--;
            }
          } else if (key === "down") {
            if (state.orgSelectedIndex < state.orgs.length - 1) {
              state.orgSelectedIndex++;
            }
          } else if (key === "enter") {
            const selected = state.orgs[state.orgSelectedIndex];
            state.org = selected.slug;
            state.selectedIndex = 0;
            state.regionFilter = null;
            state.mode = "normal";
            await refreshAndRender();
          } else if (key === "escape") {
            state.mode = "normal";
          }
          Deno.stdout.writeSync(encoder.encode(renderScreen(state)));
          continue;
        }

        if (key === "up") {
          const filtered = getFilteredSandboxes(state);
          if (state.selectedIndex > 0) {
            state.selectedIndex--;
          }
          // Clamp to filtered list length
          if (filtered.length > 0) {
            state.selectedIndex = Math.min(
              state.selectedIndex,
              filtered.length - 1,
            );
          }
        } else if (key === "down") {
          const filtered = getFilteredSandboxes(state);
          if (state.selectedIndex < filtered.length - 1) {
            state.selectedIndex++;
          }
        } else if (key === "r") {
          await refreshAndRender();
          continue;
        } else if (key === "k") {
          const selected = getSelectedSandbox(state);
          if (selected && selected.status === "running") {
            state.loading = true;
            Deno.stdout.writeSync(encoder.encode(renderScreen(state)));

            const result = await killSandbox(client, org, selected.id);
            if (result.error) {
              state.error = result.error;
            }
            state.loading = false;

            await refreshAndRender();
            continue;
          }
        } else if (key === "s") {
          // SSH — break out of keypress loop to hand terminal to SSH
          const selected = getSelectedSandbox(state);
          if (selected && selected.status === "running") {
            sshTarget = selected.id;
            break;
          }
        } else if (key === "e") {
          // Enter extend mode — shows duration picker in footer
          const selected = getSelectedSandbox(state);
          if (selected && selected.status === "running") {
            state.mode = "extend";
          }
        } else if (key === "f") {
          // Cycle region filter: all → region1 → region2 → ... → all
          const regions = [
            ...new Set(
              state.sandboxes.map((s) => s.cluster_hostname.split(".")[0]),
            ),
          ].sort();

          if (state.regionFilter === null) {
            // Currently showing all — switch to first region
            if (regions.length > 0) {
              state.regionFilter = regions[0];
            }
          } else {
            const idx = regions.indexOf(state.regionFilter);
            if (idx < regions.length - 1) {
              state.regionFilter = regions[idx + 1];
            } else {
              state.regionFilter = null;
            }
          }

          // Clamp selection to filtered list
          const filtered = getFilteredSandboxes(state);
          if (filtered.length > 0) {
            state.selectedIndex = Math.min(
              state.selectedIndex,
              filtered.length - 1,
            );
          } else {
            state.selectedIndex = 0;
          }
        } else if (key === "o") {
          // Cycle sort: created → status → region → created
          const order: Array<"created" | "status" | "region"> = [
            "created",
            "status",
            "region",
          ];
          const idx = order.indexOf(state.sortBy);
          state.sortBy = order[(idx + 1) % order.length];
        } else if (key === "O") {
          // Toggle sort direction between ascending and descending
          state.sortAsc = !state.sortAsc;
        } else if (key === "t") {
          // Open org picker — only if there are multiple orgs to choose from
          if (state.orgs.length > 1) {
            state.mode = "org";
            // Start with the current org highlighted
            const currentIdx = state.orgs.findIndex((o) =>
              o.slug === state.org
            );
            state.orgSelectedIndex = currentIdx >= 0 ? currentIdx : 0;
          }
        } else if (key === "c") {
          // Copy selected sandbox ID to clipboard
          const selected = getSelectedSandbox(state);
          if (selected) {
            try {
              await copyToClipboard(selected.id);
              state.statusMessage = `Copied: ${selected.id}`;
            } catch (e) {
              state.statusMessage = `Copy failed: ${(e as Error).message}`;
            }
          }
        }

        Deno.stdout.writeSync(encoder.encode(renderScreen(state)));
        // Clear status message after it's been rendered so the next
        // keypress starts with a clean footer
        state.statusMessage = null;
      }

      // Handle SSH — we're outside the keypress loop now,
      // so stdin's reader lock has been released
      if (sshTarget) {
        const targetId = sshTarget;
        sshTarget = null;

        // Pause auto-refresh while SSH is running
        if (refreshTimer) clearInterval(refreshTimer);

        // Restore terminal for SSH (exit raw mode, show cursor, clear screen)
        restoreTerminal();
        Deno.stdout.writeSync(encoder.encode(CLEAR_SCREEN + CURSOR_HOME));

        try {
          const token = await getAuth(options, true);
          await using sandbox = await Sandbox.connect({
            id: targetId,
            apiEndpoint: options.endpoint,
            debug: options.debug,
            token,
            org,
          });

          const ssh = await sandbox.exposeSsh();
          const connectInfo = ssh.username + "@" + ssh.hostname;

          console.log(`ssh ${connectInfo}`);
          const sshProcess = new Deno.Command("ssh", {
            args: [connectInfo],
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }).spawn();
          await sshProcess.output();
        } catch (e) {
          state.error = (e as Error).message;
        }

        // Re-enter raw mode and restart the dashboard
        Deno.stdin.setRaw(true);
        Deno.stdout.writeSync(encoder.encode(HIDE_CURSOR));

        // Refresh data since things may have changed during SSH
        await refreshAndRender();

        // Restart auto-refresh
        refreshTimer = setInterval(refreshAndRender, 5000);
      }
    }
  } finally {
    if (refreshTimer) clearInterval(refreshTimer);
    Deno.removeSignalListener("SIGWINCH", resizeHandler);
    restoreTerminal();
    Deno.stdout.writeSync(encoder.encode(CLEAR_SCREEN + CURSOR_HOME));
  }
}

// --- Cliffy command export ---

// This follows the exact same pattern as all other commands in the project.
// actionHandler wraps the function with config loading and error handling.
export const sandboxDashboardCommand = new Command<SandboxContext>()
  .description("Interactive dashboard for browsing and managing sandboxes")
  .action(actionHandler(async (config, options) => {
    config.noCreate();

    // If the terminal isn't interactive (e.g. output is piped),
    // fall back to the regular list output instead of the TUI
    if (!Deno.stdin.isTerminal()) {
      console.error(
        "Dashboard requires an interactive terminal. Use 'sandbox list' instead.",
      );
      Deno.exit(1);
    }

    const org = await getOrg(options, config, options.org);
    const client = createTrpcClient(options, true);

    await runDashboard(client, org, options);
  }));
