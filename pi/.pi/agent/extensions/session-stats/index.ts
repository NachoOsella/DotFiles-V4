/**
 * Session Stats Extension
 *
 * Commands:
 *   /stats         - Statistics for the current session
 *   /stats all     - Statistics across all sessions
 *   /stats all 7   - Last 7 days
 *   /stats all 30  - Last 30 days
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { showStatsModal } from "./modal.js";
import { buildAllStatsOutput, buildCurrentSessionOutput } from "./output.js";
import { parseCurrentBranch, parseSessionFile } from "./parser.js";
import type { SessionEntryLike, SessionStats } from "./types.js";

/** Register the /stats command for current-session and all-session stats. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show session statistics. /stats | /stats all [days]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const command = (parts[0] || "").toLowerCase();

      if (command === "all") {
        await showAllSessionStats(parts[1], ctx);
        return;
      }

      showCurrentSessionStats(ctx);
    },
  });
}

/** Parse all saved sessions and display aggregate stats. */
async function showAllSessionStats(daysArg: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
  const daysFilter = daysArg ? parseInt(daysArg, 10) : undefined;
  if (daysArg && Number.isNaN(daysFilter)) {
    ctx.ui.notify("Usage: /stats all [days]", "warning");
    return;
  }

  const sessionList = await SessionManager.listAll();
  if (!sessionList || sessionList.length === 0) {
    ctx.ui.notify("No sessions found.", "info");
    return;
  }

  ctx.ui.setStatus("stats", "Parsing " + sessionList.length + " sessions...");
  const allStats: SessionStats[] = [];
  for (const session of sessionList) {
    try {
      const stats = await parseSessionFile(session.path);
      stats.name = session.name || stats.name;
      allStats.push(stats);
    } catch {
      // Skip unreadable or incompatible session files.
    }
  }

  ctx.ui.setStatus("stats", "");
  if (allStats.length === 0) {
    ctx.ui.notify("No parseable sessions found.", "warning");
    return;
  }

  showStatsModal((width: number, theme?: any) => buildAllStatsOutput(allStats, daysFilter, width, theme), ctx);
}

/** Parse the current session branch and display its stats. */
function showCurrentSessionStats(ctx: ExtensionCommandContext): void {
  const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
  const stats = parseCurrentBranch(
    branch,
    ctx.sessionManager.getSessionFile() || "ephemeral",
    ctx.sessionManager.getSessionName() || undefined,
  );

  showStatsModal((width: number, theme?: any) => buildCurrentSessionOutput(stats, width, theme), ctx);
}
