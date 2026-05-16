import { buildModelStats, buildToolUsage } from "./aggregate.js";
import { mkBox } from "./box.js";
import { fmtCost, fmtDuration, formatCacheHit, formatNumber } from "./format.js";
import { buildModelBox, buildToolBox } from "./panels.js";
import type { AggregatedModelUsage, SessionStats } from "./types.js";

const MS_DAY = 24 * 60 * 60 * 1000;

/** Build rendered output for `/stats all [days]`. */
export function buildAllStatsOutput(sessions: SessionStats[], daysFilter: number | undefined, width: number, theme?: any): string {
  const box = mkBox(width, theme);
  const filtered = filterByDays(sessions, daysFilter);
  if (filtered.length === 0) return "No sessions found for the given period.";

  const totals = calculateAllSessionTotals(filtered, daysFilter);
  const parts: string[] = [];

  parts.push([box.hline(), box.sectionCentered("PI SESSION STATS"), box.divider(),
    box.note(" Scope  " + (daysFilter ? "last " + daysFilter + " days" : "all sessions")),
    box.note(" Close  q / enter / esc"),
    box.hlineEnd()].join("\n"));

  parts.push([box.hline(), box.sectionCentered("OVERVIEW"), box.divider(),
    box.row("Sessions", formatNumber(filtered.length)),
    box.row("Messages", formatNumber(totals.totalMessages)),
    box.row("Days", String(totals.effectiveDays)),
    box.hlineEnd()].join("\n"));

  parts.push([box.hline(), box.sectionCentered("COST & TOKENS"), box.divider(),
    box.row("Total Cost", fmtCost(totals.totalCost)),
    box.row("Avg Cost/Day", fmtCost(totals.costPerDay)),
    box.row("Avg Tokens/Session", formatNumber(totals.avgTokensPerSession)),
    box.row("Median Tokens/Session", formatNumber(totals.medianTokens)),
    box.row("Total", formatNumber(totals.totalTokensWithCache)),
    box.row("Input", formatNumber(totals.totalInput)),
    box.row("Output", formatNumber(totals.totalOutput)),
    box.row("Cache Read", formatNumber(totals.totalCacheRead)),
    box.row("Read Cache Hit", formatCacheHit(totals.totalInput, totals.totalCacheRead, theme)),
    box.hlineEnd()].join("\n"));

  const modelBox = buildModelBox(buildModelStats(filtered).slice(0, 3), width, theme);
  if (modelBox) parts.push(modelBox);

  const toolBox = buildToolBox(buildToolUsage(filtered), width, theme);
  if (toolBox) parts.push(toolBox);

  return parts.join("\n\n");
}

/** Build rendered output for current-session `/stats`. */
export function buildCurrentSessionOutput(stats: SessionStats, width: number, theme?: any): string {
  const box = mkBox(width, theme);
  const parts: string[] = [];

  parts.push([box.hline(), box.sectionCentered("PI SESSION STATS"), box.divider(),
    box.note(" Scope  current session"),
    box.note(" Close  q / enter / esc"),
    box.hlineEnd()].join("\n"));

  parts.push([box.hline(), box.sectionCentered("CURRENT SESSION"), box.divider(),
    box.row("Messages", formatNumber(stats.userMessages + stats.assistantMessages + stats.toolResults + stats.customMessages)),
    box.row("User", formatNumber(stats.userMessages)),
    box.row("Assistant", formatNumber(stats.assistantMessages)),
    box.row("Tool results", formatNumber(stats.toolResults)),
    box.row("Duration", fmtDuration(stats.durationMs ?? -1)),
    box.hlineEnd()].join("\n"));

  parts.push([box.hline(), box.sectionCentered("COST & TOKENS"), box.divider(),
    box.row("Total", formatNumber(stats.totalTokens.totalTokens)),
    box.row("Input", formatNumber(stats.totalTokens.input)),
    box.row("Output", formatNumber(stats.totalTokens.output)),
    box.row("Cache Read", formatNumber(stats.totalTokens.cacheRead)),
    box.row("Read Cache Hit", formatCacheHit(stats.totalTokens.input, stats.totalTokens.cacheRead, theme)),
    box.row("Cost", fmtCost(stats.totalTokens.cost.total)),
    box.hlineEnd()].join("\n"));

  const toolBox = buildToolBox(stats.toolCalls, width, theme);
  if (toolBox) parts.push(toolBox);

  const models: AggregatedModelUsage[] = stats.models.slice(0, 3).map((model) => ({
    provider: model.provider,
    modelId: model.modelId,
    messages: model.count,
    input: model.input,
    output: model.output,
    cacheRead: model.cacheRead,
    cacheWrite: model.cacheWrite,
    cost: model.cost,
  }));
  const modelBox = buildModelBox(models, width, theme);
  if (modelBox) parts.push(modelBox);

  return parts.join("\n\n");
}

/** Filter sessions by optional day range. */
function filterByDays(sessions: SessionStats[], daysFilter: number | undefined): SessionStats[] {
  if (!daysFilter) return sessions;
  const cutoff = Date.now() - daysFilter * MS_DAY;
  return sessions.filter((session) => session.startTime && new Date(session.startTime).getTime() >= cutoff);
}

/** Calculate aggregate totals for the all-sessions view. */
function calculateAllSessionTotals(filtered: SessionStats[], daysFilter: number | undefined) {
  const now = Date.now();
  let totalMessages = 0;
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalTokensWithCache = 0;
  let earliest = Date.now();
  let latest = 0;
  const sessionTokenTotals: number[] = [];

  for (const session of filtered) {
    const startedAt = session.startTime ? new Date(session.startTime).getTime() : now;
    if (startedAt < earliest) earliest = startedAt;
    if (startedAt > latest) latest = startedAt;

    const sessionTokens = Math.max(
      session.totalTokens.totalTokens,
      session.totalTokens.input + session.totalTokens.output + session.totalTokens.cacheRead,
    );
    sessionTokenTotals.push(sessionTokens);
    totalMessages += session.userMessages + session.assistantMessages + session.toolResults + session.customMessages;
    totalCost += session.totalTokens.cost.total;
    totalInput += session.totalTokens.input;
    totalOutput += session.totalTokens.output;
    totalCacheRead += session.totalTokens.cacheRead;
    totalTokensWithCache += sessionTokens;
  }

  const rangeDays = Math.max(1, Math.ceil((latest - earliest) / MS_DAY));
  const effectiveDays = daysFilter ?? rangeDays;
  const avgTokensPerSession = filtered.length > 0 ? Math.round(totalTokensWithCache / filtered.length) : 0;
  return {
    totalMessages,
    totalCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalTokensWithCache,
    effectiveDays,
    costPerDay: totalCost / effectiveDays,
    avgTokensPerSession,
    medianTokens: median(sessionTokenTotals),
  };
}

/** Calculate median token count. */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length === 0) return 0;
  if (values.length % 2 === 0) return Math.round((values[mid - 1] + values[mid]) / 2);
  return values[mid];
}
