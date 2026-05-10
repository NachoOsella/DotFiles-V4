/**
 * Session Stats Extension
 *
 * Plain white text, no ANSI colors.
 *
 * Commands:
 *   /stats         - Statistics for the current session
 *   /stats all     - Statistics across all sessions
 *   /stats all 7   - Last 7 days
 *   /stats all 30  - Last 30 days
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionStats {
  file: string;
  name?: string;
  startTime?: string;
  durationMs?: number;
  totalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: { name: string; count: number }[];
  models: { provider: string; modelId: string; count: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }[];
  customMessages: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toLocaleString("en-US");
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return value.toFixed(value >= 10 || value === 0 ? 0 : 1) + "%";
}

function readCacheHitRate(input: number, cacheRead: number): number {
  const promptTokens = input + cacheRead;
  return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "$0";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}

// ---------------------------------------------------------------------------
// TUI display via custom modal (raw monospace, no notify wrapper)
// ---------------------------------------------------------------------------

function showStatsModal(buildFn: (width: number, theme?: any) => string, ctx: ExtensionCommandContext) {
  if (!ctx.hasUI) {
    ctx.ui.notify(buildFn(56), "info");
    return;
  }

  ctx.ui.custom((_tui: any, _theme: any, _kb: any, done: (value?: unknown) => void) => {
    const output = new Text("", 0, 0);

    return {
      render: (width: number) => {
        const boxWidth = Math.max(2, Math.min(56, width - 2));
        const rendered = buildFn(boxWidth, _theme)
          .split("\n")
          .map((line) => truncateToWidth(line, width, "", false))
          .join("\n");
        output.setText(rendered);
        return output.render(width);
      },
      invalidate: () => output.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
          done(undefined);
        }
      },
    };
  });
}

function fmtDuration(ms: number): string {
  if (ms < 0) return "--";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return m + "m " + remS + "s";
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return h + "h " + remM + "m";
}

function fitToWidth(text: string, width: number): string {
  return truncateToWidth(text, width, "", true);
}

function color(theme: any, token: string, text: string): string {
  return theme?.fg ? theme.fg(token, text) : text;
}

function bold(theme: any, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

function padRightVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function progressBar(value: number, max: number, width: number, theme?: any): string {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const filled = Math.round(ratio * width);
  return color(theme, "accent", "█".repeat(filled)) + color(theme, "dim", "░".repeat(Math.max(0, width - filled)));
}

function formatCacheHit(input: number, cacheRead: number, theme?: any): string {
  const hitRate = readCacheHitRate(input, cacheRead);
  return formatPercent(hitRate).padStart(5) + " " + progressBar(hitRate, 100, 10, theme);
}

function finalizeTotalTokens(stats: Pick<SessionStats, "totalTokens">, fallbackTotalTokens = 0) {
  const computedTotal =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.cacheRead;
  stats.totalTokens.totalTokens = Math.max(computedTotal, fallbackTotalTokens);
}

// ---------------------------------------------------------------------------
// Box renderer — rounded, theme-aware, width-adaptive
// ---------------------------------------------------------------------------

const TL = "╭", TR = "╮", BL = "╰", BR = "╯";
const HL = "─", VL = "│", LX = "├", RX = "┤";

function mkBox(w: number, theme?: any) {
  const border = (s: string) => color(theme, "border", s);
  const borderAccent = (s: string) => color(theme, "borderAccent", s);

  return {
    hline: () => borderAccent(TL + HL.repeat(w) + TR),
    hlineEnd: () => border(BL + HL.repeat(w) + BR),
    divider: () => border(LX + HL.repeat(w) + RX),
    sectionCentered: (title: string) => {
      const rawTitle = truncateToWidth(title, w - 2, "", false);
      const cleanTitle = " " + rawTitle + " ";
      const titleWidth = visibleWidth(cleanTitle);
      const leftPad = Math.floor((w - titleWidth) / 2);
      const rightPad = w - titleWidth - leftPad;
      return border(VL) + color(theme, "dim", " ".repeat(Math.max(0, leftPad))) + color(theme, "accent", bold(theme, cleanTitle)) + color(theme, "dim", " ".repeat(Math.max(0, rightPad))) + border(VL);
    },
    row: (label: string, value: string) => {
      const cleanLabel = truncateToWidth(label, Math.max(1, w - 2), "", false);
      const labelWidth = visibleWidth(cleanLabel);
      const cleanValue = truncateToWidth(value, Math.max(0, w - labelWidth - 2), "", false);
      const valueWidth = visibleWidth(cleanValue);
      const gap = Math.max(1, w - labelWidth - valueWidth - 1);
      return border(VL) + color(theme, "muted", cleanLabel) + " ".repeat(gap) + color(theme, "text", cleanValue) + " " + border(VL);
    },
    content: (text: string) => {
      return border(VL) + padRightVisible(fitToWidth(text, w), w) + border(VL);
    },
    note: (text: string) => {
      return border(VL) + color(theme, "dim", padRightVisible(fitToWidth(text, w), w)) + border(VL);
    },
  };
}

// ---------------------------------------------------------------------------
// Display builders
// ---------------------------------------------------------------------------

function buildToolBox(tools: { name: string; count: number }[], w: number, theme?: any): string {
  if (tools.length === 0) return "";
  const b = mkBox(w, theme);
  const total = Math.max(1, tools.reduce((s, t) => s + t.count, 0));
  const maxCount = Math.max(1, tools[0].count);
  const barMax = Math.min(20, Math.max(8, w - 36));
  const maxNameLen = Math.min(18, Math.max(8, w - 38));

  const lines: string[] = [];
  lines.push(b.hline());
  lines.push(b.sectionCentered("TOOL USAGE"));
  lines.push(b.divider());

  for (const t of tools) {
    const barLen = Math.max(1, Math.round((t.count / maxCount) * barMax));
    const bar = color(theme, "accent", "█".repeat(barLen)) + color(theme, "dim", "░".repeat(Math.max(0, barMax - barLen)));
    const pct = ((t.count / total) * 100).toFixed(0) + "%";
    const name = fitToWidth(t.name, maxNameLen);
    const countStr = truncateToWidth(formatNumber(t.count), 7, "", false).padStart(7);
    const pctStr = pct.padStart(4);
    const rowStr = " " + color(theme, "text", name) + " " + bar + " " + color(theme, "text", countStr) + color(theme, "dim", " (" + pctStr + ")");
    lines.push(b.content(rowStr));
  }
  lines.push(b.hlineEnd());
  return lines.join("\n");
}

function buildModelBox(models: Array<{ provider: string; modelId: string; messages: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>, w: number, theme?: any): string {
  if (models.length === 0) return "";
  const b = mkBox(w, theme);

  const lines: string[] = [];
  lines.push(b.hline());
  lines.push(b.sectionCentered("MODEL USAGE"));
  lines.push(b.divider());

  models.forEach((m, idx) => {
    const key = m.provider + "/" + m.modelId;
    lines.push(b.content(" " + color(theme, "toolTitle", bold(theme, key))));
    lines.push(b.row("Messages", formatNumber(m.messages)));
    lines.push(b.row("Input", formatNumber(m.input)));
    lines.push(b.row("Output", formatNumber(m.output)));
    lines.push(b.row("Cache Read", formatNumber(m.cacheRead)));
    lines.push(b.row("Read Cache Hit", formatCacheHit(m.input, m.cacheRead, theme)));
    lines.push(b.row("Cost", fmtCost(m.cost)));
    if (idx < models.length - 1) {
      lines.push(b.divider());
    }
  });
  lines.push(b.hlineEnd());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stats aggregation
// ---------------------------------------------------------------------------

function buildToolUsage(sessions: SessionStats[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const s of sessions) {
    for (const t of s.toolCalls) {
      map.set(t.name, (map.get(t.name) ?? 0) + t.count);
    }
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function buildModelStats(sessions: SessionStats[]) {
  const map = new Map<string, { provider: string; modelId: string; messages: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
  for (const s of sessions) {
    for (const m of s.models) {
      const key = m.provider + "/" + m.modelId;
      const existing = map.get(key);
      if (existing) {
        existing.messages += m.count;
        existing.input += m.input;
        existing.output += m.output;
        existing.cacheRead += m.cacheRead;
        existing.cacheWrite += m.cacheWrite;
        existing.cost += m.cost;
      } else {
        map.set(key, {
          provider: m.provider, modelId: m.modelId,
          messages: m.count, input: m.input, output: m.output,
          cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, cost: m.cost,
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.messages - a.messages);
}

// ---------------------------------------------------------------------------
// Output builders
// ---------------------------------------------------------------------------

function buildAllStatsOutput(sessions: SessionStats[], daysFilter: number | undefined, w: number, theme?: any): string {
  const b = mkBox(w, theme);
  const now = Date.now();
  const MS_DAY = 24 * 60 * 60 * 1000;
  const cutoff = daysFilter ? now - daysFilter * MS_DAY : 0;

  const filtered = daysFilter
    ? sessions.filter(s => s.startTime && new Date(s.startTime).getTime() >= cutoff)
    : sessions;

  if (filtered.length === 0) return "No sessions found for the given period.";

  let totalMessages = 0;
  let totalCost = 0;
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalTokensWithCache = 0;
  let earliest = Date.now(), latest = 0;
  const sessionTokenTotals: number[] = [];

  for (const s of filtered) {
    const st = s.startTime ? new Date(s.startTime).getTime() : now;
    if (st < earliest) earliest = st;
    if (st > latest) latest = st;
    const sessTokens = Math.max(
      s.totalTokens.totalTokens,
      s.totalTokens.input + s.totalTokens.output + s.totalTokens.cacheRead
    );
    sessionTokenTotals.push(sessTokens);
    totalMessages += s.userMessages + s.assistantMessages + s.toolResults + s.customMessages;
    totalCost += s.totalTokens.cost.total;
    totalInput += s.totalTokens.input;
    totalOutput += s.totalTokens.output;
    totalCacheRead += s.totalTokens.cacheRead;
    totalTokensWithCache += sessTokens;
  }

  const rangeDays = Math.max(1, Math.ceil((latest - earliest) / MS_DAY));
  const effectiveDays = daysFilter ?? rangeDays;
  const costPerDay = totalCost / effectiveDays;
  const avgTokensPerSession = filtered.length > 0 ? Math.round(totalTokensWithCache / filtered.length) : 0;
  sessionTokenTotals.sort((a, b) => a - b);
  const mid = Math.floor(sessionTokenTotals.length / 2);
  const medianTokens = sessionTokenTotals.length === 0 ? 0
    : sessionTokenTotals.length % 2 === 0
      ? Math.round((sessionTokenTotals[mid - 1] + sessionTokenTotals[mid]) / 2)
      : sessionTokenTotals[mid];

  const parts: string[] = [];

  parts.push([b.hline(), b.sectionCentered("PI SESSION STATS"), b.divider(),
    b.note(" Scope  " + (daysFilter ? "last " + daysFilter + " days" : "all sessions")),
    b.note(" Close  q / enter / esc"),
    b.hlineEnd()].join("\n"));

  parts.push([b.hline(), b.sectionCentered("OVERVIEW"), b.divider(),
    b.row("Sessions", formatNumber(filtered.length)),
    b.row("Messages", formatNumber(totalMessages)),
    b.row("Days", String(effectiveDays)),
    b.hlineEnd()].join("\n"));

  parts.push([b.hline(), b.sectionCentered("COST & TOKENS"), b.divider(),
    b.row("Total Cost", fmtCost(totalCost)),
    b.row("Avg Cost/Day", fmtCost(costPerDay)),
    b.row("Avg Tokens/Session", formatNumber(avgTokensPerSession)),
    b.row("Median Tokens/Session", formatNumber(medianTokens)),
    b.row("Total", formatNumber(totalTokensWithCache)),
    b.row("Input", formatNumber(totalInput)),
    b.row("Output", formatNumber(totalOutput)),
    b.row("Cache Read", formatNumber(totalCacheRead)),
    b.row("Read Cache Hit", formatCacheHit(totalInput, totalCacheRead, theme)),
    b.hlineEnd()].join("\n"));

  const models = buildModelStats(filtered).slice(0, 3);
  const modelBox = buildModelBox(models, w, theme);
  if (modelBox) parts.push(modelBox);

  const tools = buildToolUsage(filtered);
  const toolBox = buildToolBox(tools, w, theme);
  if (toolBox) parts.push(toolBox);

  return parts.join("\n\n");
}

function buildCurrentSessionOutput(stats: SessionStats, w: number, theme?: any): string {
  const b = mkBox(w, theme);
  const parts: string[] = [];

  parts.push([b.hline(), b.sectionCentered("PI SESSION STATS"), b.divider(),
    b.note(" Scope  current session"),
    b.note(" Close  q / enter / esc"),
    b.hlineEnd()].join("\n"));

  parts.push([b.hline(), b.sectionCentered("CURRENT SESSION"), b.divider(),
    b.row("Messages", formatNumber(stats.userMessages + stats.assistantMessages + stats.toolResults + stats.customMessages)),
    b.row("User", formatNumber(stats.userMessages)),
    b.row("Assistant", formatNumber(stats.assistantMessages)),
    b.row("Tool results", formatNumber(stats.toolResults)),
    b.row("Duration", fmtDuration(stats.durationMs ?? -1)),
    b.hlineEnd()].join("\n"));

  parts.push([b.hline(), b.sectionCentered("COST & TOKENS"), b.divider(),
    b.row("Total", formatNumber(stats.totalTokens.totalTokens)),
    b.row("Input", formatNumber(stats.totalTokens.input)),
    b.row("Output", formatNumber(stats.totalTokens.output)),
    b.row("Cache Read", formatNumber(stats.totalTokens.cacheRead)),
    b.row("Read Cache Hit", formatCacheHit(stats.totalTokens.input, stats.totalTokens.cacheRead, theme)),
    b.row("Cost", fmtCost(stats.totalTokens.cost.total)),
    b.hlineEnd()].join("\n"));

  const toolBox = buildToolBox(stats.toolCalls, w, theme);
  if (toolBox) parts.push(toolBox);

  const modelBox = buildModelBox(stats.models.slice(0, 3).map(m => ({
    provider: m.provider, modelId: m.modelId,
    messages: m.count,
    input: m.input, output: m.output,
    cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, cost: m.cost,
  })), w, theme);
  if (modelBox) parts.push(modelBox);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Session parser
// ---------------------------------------------------------------------------

async function parseSessionFile(filePath: string): Promise<SessionStats> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");

  const stats: SessionStats = {
    file: filePath, name: undefined, startTime: undefined,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    userMessages: 0, assistantMessages: 0, toolResults: 0,
    toolCalls: [], models: [], customMessages: 0,
  };

  const toolCallMap = new Map<string, number>();
  const modelMap = new Map<string, { provider: string; modelId: string; count: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
  let firstTimestamp: string | undefined;
  let reportedTotalTokens = 0;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(rawLine); } catch { continue; }

    if (entry.timestamp && !firstTimestamp) firstTimestamp = entry.timestamp;
    if (entry.type === "session") continue;

    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (msg.role === "user") {
        stats.userMessages++;
      } else if (msg.role === "assistant") {
        stats.assistantMessages++;
        if (msg.provider && msg.model) {
          const key = msg.provider + "/" + msg.model;
          const ex = modelMap.get(key);
          if (ex) { ex.count++; }
          else { modelMap.set(key, { provider: msg.provider, modelId: msg.model, count: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }); }
        }
        if (msg.usage) {
          const u = msg.usage;
          stats.totalTokens.input += u.input ?? 0;
          stats.totalTokens.output += u.output ?? 0;
          stats.totalTokens.cacheRead += u.cacheRead ?? 0;
          stats.totalTokens.cacheWrite += u.cacheWrite ?? 0;
          reportedTotalTokens += u.totalTokens ?? 0;
          stats.totalTokens.cost.total += u.cost?.total ?? 0;
          if (msg.provider && msg.model) {
            const key = msg.provider + "/" + msg.model;
            const ex = modelMap.get(key);
            if (ex) {
              ex.input += u.input ?? 0; ex.output += u.output ?? 0;
              ex.cacheRead += u.cacheRead ?? 0; ex.cacheWrite += u.cacheWrite ?? 0;
              ex.cost += u.cost?.total ?? 0;
            }
          }
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "toolCall" && block.name) {
              toolCallMap.set(block.name, (toolCallMap.get(block.name) ?? 0) + 1);
            }
          }
        }
      } else if (msg.role === "toolResult") {
        stats.toolResults++;
      } else if (msg.role === "custom") {
        stats.customMessages++;
      }
    }

    if (entry.type === "session_info" && entry.name) stats.name = entry.name;
  }

  stats.startTime = firstTimestamp;
  stats.toolCalls = Array.from(toolCallMap.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  stats.models = Array.from(modelMap.values()).sort((a, b) => b.count - a.count);
  finalizeTotalTokens(stats, reportedTotalTokens);

  return stats;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show session statistics. /stats | /stats all [days]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || "").toLowerCase();

      if (cmd === "all") {
        const daysFilter = parts[1] ? parseInt(parts[1], 10) : undefined;
        if (parts[1] && isNaN(daysFilter!)) {
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
            const s = await parseSessionFile(session.path);
            s.name = session.name || s.name;
            allStats.push(s);
          } catch { /* skip */ }
        }

        ctx.ui.setStatus("stats", "");
        if (allStats.length === 0) {
          ctx.ui.notify("No parseable sessions found.", "warning");
          return;
        }

        showStatsModal((w: number, theme?: any) => buildAllStatsOutput(allStats, daysFilter, w, theme), ctx);

      } else {
        // Current session
        const branch = ctx.sessionManager.getBranch();

        const stats: SessionStats = {
          file: ctx.sessionManager.getSessionFile() || "ephemeral",
          name: ctx.sessionManager.getSessionName() || undefined,
          startTime: undefined,
          totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
          userMessages: 0, assistantMessages: 0, toolResults: 0,
          toolCalls: [], models: [], customMessages: 0,
        };

        const toolCallMap = new Map<string, number>();
        const modelMap = new Map<string, { provider: string; modelId: string; count: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
        let firstTs: number | undefined;
        let lastTs: number | undefined;
        let reportedTotalTokens = 0;

        for (const entry of branch) {
          if (entry.type === "session") {
            if (entry.timestamp) firstTs = new Date(entry.timestamp).getTime();
            continue;
          }
          if (!firstTs && entry.timestamp) firstTs = new Date(entry.timestamp).getTime();
          if (entry.timestamp) lastTs = new Date(entry.timestamp).getTime();
          if (entry.type !== "message" || !entry.message) continue;
          const msg = entry.message;

          if (msg.role === "user") stats.userMessages++;
          else if (msg.role === "assistant") {
            stats.assistantMessages++;
            if (msg.provider && msg.model) {
              const key = msg.provider + "/" + msg.model;
              const ex = modelMap.get(key);
              if (ex) ex.count++;
              else modelMap.set(key, { provider: msg.provider, modelId: msg.model, count: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
            }
            if (msg.usage) {
              const u = msg.usage;
              stats.totalTokens.input += u.input ?? 0;
              stats.totalTokens.output += u.output ?? 0;
              stats.totalTokens.cacheRead += u.cacheRead ?? 0;
              stats.totalTokens.cacheWrite += u.cacheWrite ?? 0;
              reportedTotalTokens += u.totalTokens ?? 0;
              stats.totalTokens.cost.total += u.cost?.total ?? 0;
              if (msg.provider && msg.model) {
                const key = msg.provider + "/" + msg.model;
                const ex = modelMap.get(key);
                if (ex) {
                  ex.input += u.input ?? 0; ex.output += u.output ?? 0;
                  ex.cacheRead += u.cacheRead ?? 0; ex.cacheWrite += u.cacheWrite ?? 0;
                  ex.cost += u.cost?.total ?? 0;
                }
              }
            }
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block?.type === "toolCall" && block.name) {
                  toolCallMap.set(block.name, (toolCallMap.get(block.name) ?? 0) + 1);
                }
              }
            }
          } else if (msg.role === "toolResult") stats.toolResults++;
          else if (msg.role === "custom") stats.customMessages++;
        }

        if (firstTs && lastTs) stats.durationMs = lastTs - firstTs;
        stats.toolCalls = Array.from(toolCallMap.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
        stats.models = Array.from(modelMap.values()).sort((a, b) => b.count - a.count);
        finalizeTotalTokens(stats, reportedTotalTokens);

        showStatsModal((w: number, theme?: any) => buildCurrentSessionOutput(stats, w, theme), ctx);
      }
    },
  });
}
