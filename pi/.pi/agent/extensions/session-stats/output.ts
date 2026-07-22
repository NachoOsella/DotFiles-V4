import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildModelStats, buildToolUsage } from "./aggregate.ts";
import { createDashboardFrame } from "./box.ts";
import {
  color,
  fmtCost,
  fmtDuration,
  formatCacheHit,
  formatNumber,
  formatPercent,
  padRightVisible,
  progressBar,
  readCacheHitRate,
} from "./format.ts";
import { buildModelRows, buildToolRows } from "./panels.ts";
import type { AggregatedModelUsage, SessionStats } from "./types.ts";

const MS_DAY = 24 * 60 * 60 * 1000;

/** Build the aggregate `/stats all [days]` dashboard. */
export function buildAllStatsOutput(
  sessions: readonly SessionStats[],
  daysFilter: number | undefined,
  width: number,
  theme?: Theme,
  projectFilter = false,
  projectName?: string,
): string {
  const filtered = filterByDays(sessions, daysFilter);
  if (filtered.length === 0) return "No sessions found for the given period.";

  const frame = createDashboardFrame(width, theme);
  const contentWidth = frame.innerWidth - 2;
  const totals = calculateAllSessionTotals(filtered);
  const models = buildModelStats(filtered);
  const tools = buildToolUsage(filtered);
  const scope = projectFilter
    ? `${projectName ?? "current project"}${daysFilter ? `, ${daysFilter}d` : ""}`
    : daysFilter
      ? `${daysFilter}d window`
      : "all sessions";
  const lines: string[] = [frame.top("SESSION STATS", scope)];

  lines.push(frame.section("Activity"));
  lines.push(
    frame.metricPair("Sessions", formatNumber(filtered.length), "Active days", formatNumber(totals.activeDays)),
    frame.metricPair("Messages", formatNumber(totals.conversationMessages), "Tool calls", formatNumber(totals.toolCalls)),
    frame.metricPair("Avg session", fmtDuration(totals.averageDurationMs), "Avg messages", formatNumber(totals.averageMessagesPerSession)),
  );

  lines.push(frame.section("Usage"));
  lines.push(
    frame.metricPair("Tokens", formatNumber(totals.totalTokens), "Cost", fmtCost(totals.totalCost)),
    frame.metricPair("Avg tokens", formatNumber(totals.averageTokensPerSession), "Median", formatNumber(totals.medianTokens)),
    frame.metricPair("Input", formatNumber(totals.input), "Output", formatNumber(totals.output)),
    frame.metricPair("Cache read", formatNumber(totals.cacheRead), "Cache write", formatNumber(totals.cacheWrite)),
    frame.metric("Cache hit", `${formatPercent(totals.cacheHitRate)}  ${progressBar(totals.cacheHitRate, 100, 10, theme, "success")}`),
  );

  lines.push(frame.section("Models"));
  lines.push(...buildModelRows(models, contentWidth, theme).map(frame.row));

  lines.push(frame.section("Top tools"));
  lines.push(...buildToolRows(tools, contentWidth, theme).map(frame.row));
  lines.push(
    frame.footer(
      projectFilter ? "esc back  q close" : "p projects  enter / esc / q close",
    ),
  );
  return lines.join("\n");
}

/** Summary of usage grouped by the session working directory. */
export interface ProjectSummary {
  project: string;
  sessions: SessionStats[];
  totals: ReturnType<typeof calculateAllSessionTotals>;
}

/** Build the project browser shown from the global all-session dashboard. */
export function buildProjectStatsOutput(
  sessions: readonly SessionStats[],
  daysFilter: number | undefined,
  width: number,
  theme?: Theme,
  selectedIndex = 0,
): string {
  const projects = buildProjectSummaries(sessions, daysFilter);
  if (projects.length === 0) return "No projects found for the given period.";

  const frame = createDashboardFrame(width, theme);
  const selected = Math.max(0, Math.min(selectedIndex, projects.length - 1));
  const lines: string[] = [
    frame.top("PROJECT STATS", `${projects.length} project${projects.length === 1 ? "" : "s"}`),
  ];

  lines.push(frame.section("Top 3 by estimated cost"));
  const topProjects = projects.slice(0, 3);
  const maxCost = Math.max(0, topProjects[0]?.totals.totalCost ?? 0);
  for (let index = 0; index < topProjects.length; index += 1) {
    const project = topProjects[index];
    if (!project) continue;
    for (const row of buildProjectTopRows(project, index, maxCost, frame.innerWidth - 2, theme)) {
      lines.push(frame.row(row));
    }
  }

  lines.push(frame.section(`All projects (${selected + 1}/${projects.length})`));
  const visibleCount = 8;
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(visibleCount / 2), projects.length - visibleCount),
  );
  const end = Math.min(projects.length, start + visibleCount);
  if (start > 0) lines.push(frame.row("... more projects above"));
  for (let index = start; index < end; index += 1) {
    const project = projects[index];
    if (!project) continue;
    lines.push(frame.row(buildProjectRow(project, theme, index === selected)));
  }
  if (end < projects.length) lines.push(frame.row("... more projects below"));
  lines.push(frame.footer("j/k move  enter detail  esc back  q close"));
  return lines.join("\n");
}

/** Group sessions by project and sort by estimated cost, then token usage. */
export function buildProjectSummaries(
  sessions: readonly SessionStats[],
  daysFilter: number | undefined,
): ProjectSummary[] {
  const groups = new Map<string, SessionStats[]>();
  for (const session of filterByDays(sessions, daysFilter)) {
    const project = session.project || "Unknown project";
    const group = groups.get(project);
    if (group) group.push(session);
    else groups.set(project, [session]);
  }

  return [...groups.entries()]
    .map(([project, groupedSessions]) => ({
      project,
      sessions: groupedSessions,
      totals: calculateAllSessionTotals(groupedSessions),
    }))
    .sort(
      (left, right) =>
        right.totals.totalCost - left.totals.totalCost ||
        right.totals.totalTokens - left.totals.totalTokens ||
        left.project.localeCompare(right.project),
    );
}

function buildProjectTopRows(
  project: ProjectSummary,
  index: number,
  maxCost: number,
  contentWidth: number,
  theme: Theme | undefined,
): string[] {
  const barWidth = Math.max(8, Math.min(16, Math.floor(contentWidth * 0.28)));
  const costWidth = 10;
  const nameWidth = Math.max(12, contentWidth - barWidth - costWidth - 2);
  const name = truncateToWidth(`${index + 1}. ${project.project}`, nameWidth, "…", false);
  const bar = progressBar(project.totals.totalCost, maxCost, barWidth, theme, "accent");
  const cost = fmtCost(project.totals.totalCost).padStart(costWidth);
  return [
    padRightVisible(color(theme, "text", name), nameWidth) +
      " " +
      bar +
      " " +
      color(theme, project.totals.totalCost > 0 ? "warning" : "muted", cost),
    color(
      theme,
      "muted",
      `   ${formatNumber(project.sessions.length)} sessions  ·  ${formatNumber(project.totals.totalTokens)} tokens`,
    ),
  ];
}

function buildProjectRow(
  project: ProjectSummary,
  theme: Theme | undefined,
  selected = false,
): string {
  const marker = selected ? ">" : " ";
  const metrics = `${formatNumber(project.sessions.length)} sessions  ${formatNumber(project.totals.totalTokens)} tokens  ${fmtCost(project.totals.totalCost)}`;
  return `${color(theme, selected ? "accent" : "text", marker)} ${color(theme, "text", project.project)} ${color(theme, "muted", metrics)}`;
}

/** Build the current-session `/stats` dashboard. */
export function buildCurrentSessionOutput(
  stats: SessionStats,
  width: number,
  theme?: Theme,
): string {
  const frame = createDashboardFrame(width, theme);
  const contentWidth = frame.innerWidth - 2;
  const conversationMessages = stats.userMessages + stats.assistantMessages;
  const toolCalls = stats.toolCalls.reduce((sum, tool) => sum + tool.count, 0);
  const models: AggregatedModelUsage[] = stats.models.map((model) => ({
    provider: model.provider,
    modelId: model.modelId,
    messages: model.count,
    input: model.input,
    output: model.output,
    cacheRead: model.cacheRead,
    cacheWrite: model.cacheWrite,
    cost: model.cost,
    pricingSource: model.pricingSource,
  }));
  const lines: string[] = [frame.top("SESSION STATS", "current")];

  lines.push(frame.section("Activity"));
  lines.push(
    frame.metricPair("Duration", fmtDuration(stats.durationMs ?? -1), "Messages", formatNumber(conversationMessages)),
    frame.metricPair("User", formatNumber(stats.userMessages), "Assistant", formatNumber(stats.assistantMessages)),
    frame.metricPair("Tool calls", formatNumber(toolCalls), "Results", formatNumber(stats.toolResults)),
  );

  lines.push(frame.section("Usage"));
  lines.push(
    frame.metricPair("Tokens", formatNumber(stats.totalTokens.totalTokens), "Cost", fmtCost(stats.totalTokens.cost.total)),
    frame.metricPair("Input", formatNumber(stats.totalTokens.input), "Output", formatNumber(stats.totalTokens.output)),
    frame.metricPair("Cache read", formatNumber(stats.totalTokens.cacheRead), "Cache write", formatNumber(stats.totalTokens.cacheWrite)),
    frame.metric("Cache hit", formatCacheHit(stats.totalTokens.input, stats.totalTokens.cacheRead, theme)),
  );

  lines.push(frame.section("Models"));
  lines.push(...buildModelRows(models, contentWidth, theme).map(frame.row));

  lines.push(frame.section("Top tools"));
  lines.push(...buildToolRows(stats.toolCalls, contentWidth, theme).map(frame.row));
  lines.push(frame.footer("enter / esc / q  close"));
  return lines.join("\n");
}

/** Aggregate values used by the all-session dashboard. */
export function calculateAllSessionTotals(sessions: readonly SessionStats[]) {
  let conversationMessages = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let durationTotal = 0;
  let durationCount = 0;
  const activeDates = new Set<string>();
  const sessionTokenTotals: number[] = [];

  for (const session of sessions) {
    conversationMessages += session.userMessages + session.assistantMessages;
    toolCalls += session.toolCalls.reduce((sum, tool) => sum + tool.count, 0);
    totalCost += session.totalTokens.cost.total;
    input += session.totalTokens.input;
    output += session.totalTokens.output;
    cacheRead += session.totalTokens.cacheRead;
    cacheWrite += session.totalTokens.cacheWrite;

    const sessionTokens = Math.max(
      session.totalTokens.totalTokens,
      session.totalTokens.input + session.totalTokens.output + session.totalTokens.cacheRead,
    );
    totalTokens += sessionTokens;
    sessionTokenTotals.push(sessionTokens);

    if (session.durationMs !== undefined) {
      durationTotal += session.durationMs;
      durationCount += 1;
    }
    const startedAt = parseDate(session.startTime);
    if (startedAt) activeDates.add(startedAt.toISOString().slice(0, 10));
  }

  return {
    activeDays: activeDates.size,
    conversationMessages,
    toolCalls,
    totalCost,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cacheHitRate: readCacheHitRate(input, cacheRead),
    averageDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : -1,
    averageMessagesPerSession: Math.round(conversationMessages / Math.max(1, sessions.length)),
    averageTokensPerSession: Math.round(totalTokens / Math.max(1, sessions.length)),
    medianTokens: median(sessionTokenTotals),
  };
}

/** Filter sessions using their valid start timestamp. */
export function filterByDays(
  sessions: readonly SessionStats[],
  daysFilter: number | undefined,
  now = Date.now(),
): SessionStats[] {
  if (!daysFilter) return [...sessions];
  const cutoff = now - daysFilter * MS_DAY;
  return sessions.filter((session) => {
    const startedAt = parseDate(session.startTime);
    return startedAt !== undefined && startedAt.getTime() >= cutoff;
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
