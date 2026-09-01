import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildModelStats,
  buildToolUsage,
  buildUnattributedUsage,
  isSubagentSession,
  mergeSessionStats,
} from "./aggregate.ts";
import { createDashboardFrame } from "./box.ts";
import {
  calculateCacheReadShare,
  color,
  fmtCost,
  fmtDuration,
  formatCacheReadShare,
  formatNumber,
  formatPercent,
  padRightVisible,
  progressBar,
} from "./format.ts";
import { buildModelRows, buildToolRows } from "./panels.ts";
import type {
  AggregatedModelUsage,
  SessionStats,
  TokenTotals,
} from "./types.ts";

const MS_DAY = 24 * 60 * 60 * 1000;

export interface DataQuality {
  parsedSessions: number;
  discoveredSessions: number;
}

/** Shape of the current context usage exposed by Pi. */
export interface CurrentContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface AggregateSessionTotals {
  rootSessionCount: number;
  subagentRuns: number;
  activeDays: number;
  conversationMessages: number;
  toolCalls: number;
  totalCost: number;
  reportedCost: number;
  catalogCost: number;
  estimatedCost: number;
  unknownTokens: number;
  pricedTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  tokenTotals: TokenTotals;
  cacheReadShare: number;
  unknownPricingPercent: number;
  pricingCoverage: number;
  averageDurationMs: number;
  averageMessagesPerSession: number;
  averageTokensPerSession: number;
  averageCostPerSession: number;
  medianTokens: number;
}

/** Build the aggregate `/stats all [days]` dashboard. */
export function buildAllStatsOutput(
  sessions: readonly SessionStats[],
  daysFilter: number | undefined,
  width: number,
  theme?: Theme,
  projectFilter = false,
  projectName?: string,
  dataQuality?: DataQuality,
): string {
  const filtered = filterByDays(sessions, daysFilter);
  if (filtered.length === 0) return "No sessions found for the given period.";

  const frame = createDashboardFrame(width, theme);
  const contentWidth = frame.innerWidth - 2;
  const totals = calculateAllSessionTotals(filtered);
  const models = buildModelStats(filtered);
  const unattributed = buildUnattributedUsage(totals.tokenTotals, models);
  const modelRows = buildModelRows(models, contentWidth, theme, unattributed);
  const tools = buildToolUsage(filtered);
  const rootProjects = new Set(
    filtered
      .filter((session) => !isSubagentSession(session))
      .map((session) => session.project || "Unknown project"),
  );
  const scope = projectFilter
    ? `${projectName ?? "current project"}${daysFilter ? `, ${daysFilter}d` : ""}`
    : daysFilter
      ? `${daysFilter}d window`
      : "all sessions";
  const quality = dataQuality ?? {
    parsedSessions: sessions.length,
    discoveredSessions: sessions.length,
  };
  const lines: string[] = [frame.top("USAGE STATS", scope)];

  const overviewRows: string[] = [];
  addMetricPair(
    overviewRows,
    frame,
    "Sessions",
    totals.rootSessionCount,
    "Subagent runs",
    totals.subagentRuns,
  );
  addMetricPair(
    overviewRows,
    frame,
    "Active days",
    totals.activeDays,
    "Projects",
    rootProjects.size,
  );
  addMetricPair(
    overviewRows,
    frame,
    "Messages",
    totals.conversationMessages,
    "Tool calls",
    totals.toolCalls,
  );
  if (totals.totalTokens > 0)
    overviewRows.push(
      frame.metric("Total usage", formatNumber(totals.totalTokens), true),
    );
  if (totals.totalCost > 0)
    overviewRows.push(frame.metric("Cost", fmtCost(totals.totalCost), true));
  addSection(lines, frame, "Overview", overviewRows);

  const perSessionRows: string[] = [];
  addMetricPair(
    perSessionRows,
    frame,
    "Median usage",
    totals.medianTokens,
    "Average usage",
    totals.averageTokensPerSession,
  );
  if (totals.averageDurationMs > 0 && totals.averageMessagesPerSession > 0) {
    perSessionRows.push(
      frame.metricPair(
        "Average span",
        fmtDuration(totals.averageDurationMs),
        "Average messages",
        formatNumber(totals.averageMessagesPerSession),
      ),
    );
  } else if (totals.averageDurationMs > 0) {
    perSessionRows.push(
      frame.metric("Average span", fmtDuration(totals.averageDurationMs)),
    );
  } else if (totals.averageMessagesPerSession > 0) {
    perSessionRows.push(
      frame.metric(
        "Average messages",
        formatNumber(totals.averageMessagesPerSession),
      ),
    );
  }
  if (totals.averageCostPerSession > 0)
    perSessionRows.push(
      frame.metric("Average cost", fmtCost(totals.averageCostPerSession)),
    );
  addSection(lines, frame, "Per session", perSessionRows);

  const costRows: string[] = [];
  if (totals.reportedCost > 0)
    costRows.push(
      frame.metric("Reported / billed", fmtCost(totals.reportedCost)),
    );
  if (totals.catalogCost > 0)
    costRows.push(
      frame.metric("Calculated catalog", fmtCost(totals.catalogCost)),
    );
  if (totals.estimatedCost > 0)
    costRows.push(
      frame.metric("Estimated value", estimatedCostLabel(totals.estimatedCost)),
    );
  if (
    totals.pricingCoverage > 0 &&
    totals.pricingCoverage < 100 &&
    totals.totalTokens > 0
  )
    costRows.push(
      frame.metric("Pricing coverage", formatPercent(totals.pricingCoverage)),
    );
  addSection(lines, frame, "Cost quality", costRows);

  if (modelRows.length > 0) {
    lines.push(frame.section("Models"));
    lines.push(...modelRows.map(frame.row));
  }

  if (tools.length > 0) {
    lines.push(frame.section("Tools"));
    lines.push(...buildToolRows(tools, contentWidth, theme).map(frame.row));
  }

  if (quality.parsedSessions < quality.discoveredSessions) {
    lines.push(frame.section("Data quality"));
    lines.push(frame.row(formatDataQuality(quality, theme)));
  }
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
  dataQuality?: DataQuality,
): string {
  const projects = buildProjectSummaries(sessions, daysFilter);
  if (projects.length === 0) return "No projects found for the given period.";

  const frame = createDashboardFrame(width, theme);
  const selected = Math.max(0, Math.min(selectedIndex, projects.length - 1));
  const lines: string[] = [
    frame.top(
      "PROJECTS",
      `${projects.length} project${projects.length === 1 ? "" : "s"}`,
    ),
  ];

  const topProjects = projects
    .filter((project) => project.totals.totalCost > 0)
    .slice(0, 3);
  if (topProjects.length > 0) {
    lines.push(frame.section("Top 3 by known cost"));
    const maxCost = topProjects[0]?.totals.totalCost ?? 0;
    for (let index = 0; index < topProjects.length; index += 1) {
      const project = topProjects[index];
      if (!project) continue;
      for (const row of buildProjectTopRows(
        project,
        index,
        maxCost,
        frame.innerWidth - 2,
        theme,
      )) {
        lines.push(frame.row(row));
      }
    }
  }

  lines.push(
    frame.section(`All projects (${selected + 1}/${projects.length})`),
  );
  const visibleCount = 8;
  const start = Math.max(
    0,
    Math.min(
      selected - Math.floor(visibleCount / 2),
      projects.length - visibleCount,
    ),
  );
  const end = Math.min(projects.length, start + visibleCount);
  if (start > 0) lines.push(frame.row("... more projects above"));
  for (let index = start; index < end; index += 1) {
    const project = projects[index];
    if (!project) continue;
    lines.push(frame.row(buildProjectRow(project, theme, index === selected)));
  }
  if (end < projects.length) lines.push(frame.row("... more projects below"));
  if (dataQuality) {
    lines.push(frame.section("Data quality"));
    lines.push(frame.row(formatDataQuality(dataQuality, theme)));
  }
  lines.push(frame.footer("j/k move  enter detail  esc back  q close"));
  return lines.join("\n");
}

/** Group sessions by known cost, then token usage. */
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
  const name = truncateToWidth(
    `${index + 1}. ${project.project}`,
    nameWidth,
    "…",
    false,
  );
  const bar = progressBar(
    project.totals.totalCost,
    maxCost,
    barWidth,
    theme,
    "accent",
  );
  const cost = fmtCost(project.totals.totalCost).padStart(costWidth);
  const headline =
    padRightVisible(color(theme, "text", name), nameWidth) +
    " " +
    bar +
    " " +
    color(theme, "warning", cost);
  const details = [
    project.totals.rootSessionCount > 0
      ? `${formatNumber(project.totals.rootSessionCount)} sessions`
      : "",
    project.totals.totalTokens > 0
      ? `${formatNumber(project.totals.totalTokens)} tokens`
      : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  return details
    ? [headline, color(theme, "muted", `   ${details}`)]
    : [headline];
}

function buildProjectRow(
  project: ProjectSummary,
  theme: Theme | undefined,
  selected = false,
): string {
  const marker = selected ? ">" : " ";
  const metrics = [
    project.totals.rootSessionCount > 0
      ? `${formatNumber(project.totals.rootSessionCount)} sessions`
      : "",
    project.totals.totalTokens > 0
      ? `${formatNumber(project.totals.totalTokens)} tokens`
      : "",
    project.totals.totalCost > 0 ? fmtCost(project.totals.totalCost) : "",
  ]
    .filter(Boolean)
    .join("  ");
  return `${color(theme, selected ? "accent" : "text", marker)} ${color(theme, "text", project.project)}${metrics ? ` ${color(theme, "muted", metrics)}` : ""}`;
}

/** Main-thread and subagent usage shown in the current-session dashboard. */
export interface CurrentSessionBreakdown {
  mainThread: SessionStats;
  subagents: readonly SessionStats[];
  contextUsage?: CurrentContextUsage;
}

/** Build the current-session `/stats` dashboard. */
export function buildCurrentSessionOutput(
  stats: SessionStats,
  width: number,
  theme?: Theme,
  breakdown?: CurrentSessionBreakdown,
): string {
  const frame = createDashboardFrame(width, theme);
  const contentWidth = frame.innerWidth - 2;
  const mainThread = breakdown?.mainThread ?? stats;
  const subagents = breakdown?.subagents ?? [];
  const subagentStats = mergeSessionStats(subagents, "subagents");
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
    reportedCost: model.reportedCost,
    catalogCost: model.catalogCost,
    estimatedCost: model.estimatedCost,
    unknownTokens: model.unknownTokens,
    pricedTokens: model.pricedTokens,
    pricingSource: model.pricingSource,
  }));
  const unattributed = buildUnattributedUsage(stats.totalTokens, models);
  const modelRows = buildModelRows(models, contentWidth, theme, unattributed);
  const lines: string[] = [
    frame.top(
      "SESSION STATS",
      subagents.length > 0
        ? `current · ${subagents.length} subagent${subagents.length === 1 ? "" : "s"}`
        : "current",
    ),
  ];

  const overviewRows: string[] = [];
  const contextRow = formatContextUsage(breakdown?.contextUsage, theme);
  if (contextRow) overviewRows.push(frame.metric("Context", contextRow, true));
  if (stats.totalTokens.totalTokens > 0)
    overviewRows.push(
      frame.metric(
        "Cumulative usage",
        formatNumber(stats.totalTokens.totalTokens),
        true,
      ),
    );
  if (stats.totalTokens.cost.total > 0)
    overviewRows.push(
      frame.metric("Cost", fmtCost(stats.totalTokens.cost.total), true),
    );
  if ((stats.durationMs ?? 0) > 0)
    overviewRows.push(
      frame.metric("Session span", fmtDuration(stats.durationMs ?? -1)),
    );
  addSection(lines, frame, "Overview", overviewRows);

  const activityRows: string[] = [];
  addMetricPair(
    activityRows,
    frame,
    "Messages",
    conversationMessages,
    "Tool calls",
    toolCalls,
  );
  addMetricPair(
    activityRows,
    frame,
    "User messages",
    stats.userMessages,
    "Assistant messages",
    stats.assistantMessages,
  );
  addMetricPair(
    activityRows,
    frame,
    "Tool results",
    stats.toolResults,
    "Custom messages",
    stats.customMessages,
  );
  addSection(lines, frame, "Activity", activityRows);

  const mainTokens = mainThread.totalTokens.totalTokens;
  const agentTokens = subagentStats.totalTokens.totalTokens;
  const mainMessages = mainThread.userMessages + mainThread.assistantMessages;
  const agentMessages =
    subagentStats.userMessages + subagentStats.assistantMessages;
  const threadHasActivity =
    agentTokens > 0 ||
    agentMessages > 0 ||
    subagentStats.toolCalls.length > 0 ||
    subagentStats.totalTokens.cost.total > 0;
  if (threadHasActivity) {
    const threadRows: string[] = [];
    const combinedTokens = mainTokens + agentTokens;
    if (mainTokens > 0 || mainThread.totalTokens.cost.total > 0) {
      threadRows.push(
        frame.row(
          buildThreadSplitRow(
            "Main thread",
            mainTokens,
            combinedTokens,
            mainThread.totalTokens.cost.total,
            contentWidth,
            theme,
            "accent",
          ),
        ),
      );
    }
    if (agentTokens > 0 || subagentStats.totalTokens.cost.total > 0) {
      threadRows.push(
        frame.row(
          buildThreadSplitRow(
            `Subagents (${subagents.length})`,
            agentTokens,
            combinedTokens,
            subagentStats.totalTokens.cost.total,
            contentWidth,
            theme,
            "success",
          ),
        ),
      );
    }
    addMetricPair(
      threadRows,
      frame,
      "Main messages",
      mainMessages,
      "Agent messages",
      agentMessages,
    );
    addSection(lines, frame, "Threads", threadRows);
  }

  const usageRows: string[] = [];
  addMetricPair(
    usageRows,
    frame,
    "Input",
    stats.totalTokens.input,
    "Output",
    stats.totalTokens.output,
  );
  addMetricPair(
    usageRows,
    frame,
    "Cache read",
    stats.totalTokens.cacheRead,
    "Cache write",
    stats.totalTokens.cacheWrite,
  );
  const promptTokens =
    stats.totalTokens.input +
    stats.totalTokens.cacheRead +
    stats.totalTokens.cacheWrite;
  if (stats.totalTokens.cacheRead > 0 && promptTokens > 0) {
    usageRows.push(
      frame.metric(
        "Cache read share",
        `${formatCacheReadShare(
          stats.totalTokens.input,
          stats.totalTokens.cacheRead,
          stats.totalTokens.cacheWrite,
          theme,
        )} of prompt tokens`,
      ),
    );
  }
  addSection(lines, frame, "Cumulative usage", usageRows);

  const costRows: string[] = [];
  const reportedCost = stats.totalTokens.cost.reported ?? 0;
  const catalogCost = stats.totalTokens.cost.catalog ?? 0;
  const estimatedCost = stats.totalTokens.cost.estimated ?? 0;
  const coverage = pricingCoverage(stats.totalTokens);
  if (reportedCost > 0)
    costRows.push(frame.metric("Reported / billed", fmtCost(reportedCost)));
  if (catalogCost > 0)
    costRows.push(frame.metric("Calculated catalog", fmtCost(catalogCost)));
  if (estimatedCost > 0)
    costRows.push(
      frame.metric("Estimated value", estimatedCostLabel(estimatedCost)),
    );
  if (coverage > 0 && coverage < 100 && stats.totalTokens.totalTokens > 0)
    costRows.push(frame.metric("Pricing coverage", formatPercent(coverage)));
  addSection(lines, frame, "Cost", costRows);

  if (modelRows.length > 0) {
    lines.push(frame.section("Models"));
    lines.push(...modelRows.map(frame.row));
  }

  if (stats.toolCalls.length > 0) {
    lines.push(frame.section("Tools"));
    lines.push(
      ...buildToolRows(stats.toolCalls, contentWidth, theme).map(frame.row),
    );
  }
  const footerMetrics = [
    conversationMessages > 0
      ? `${formatNumber(conversationMessages)} messages`
      : "",
    toolCalls > 0 ? `${formatNumber(toolCalls)} tool calls` : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  lines.push(
    frame.footer(
      `${footerMetrics ? `${footerMetrics}  ·  ` : ""}enter / esc / q close`,
    ),
  );
  return lines.join("\n");
}

function buildThreadSplitRow(
  label: string,
  value: number,
  total: number,
  cost: number,
  contentWidth: number,
  theme: Theme | undefined,
  fillToken: Parameters<Theme["fg"]>[0],
): string {
  const labelWidth = Math.min(14, Math.max(8, Math.floor(contentWidth * 0.27)));
  const tokenWidth = 8;
  const percentWidth = 5;
  const costWidth = 10;
  const barWidth = Math.max(
    4,
    contentWidth - labelWidth - tokenWidth - percentWidth - costWidth - 5,
  );
  const percentage = total > 0 ? (value / total) * 100 : 0;
  const fittedLabel = padRightVisible(
    truncateToWidth(label, labelWidth, "…", false),
    labelWidth,
  );
  const costColumn =
    cost > 0
      ? ` ${color(theme, "warning", fmtCost(cost).padStart(costWidth))}`
      : "";
  return `${color(theme, "text", fittedLabel)} ${color(theme, "accent", formatNumber(value).padStart(tokenWidth))} ${progressBar(value, total, barWidth, theme, fillToken)} ${color(theme, "muted", formatPercent(percentage).padStart(percentWidth))}${costColumn}`;
}

/** Aggregate values used by the all-session dashboard. */
export function calculateAllSessionTotals(
  sessions: readonly SessionStats[],
): AggregateSessionTotals {
  let conversationMessages = 0;
  let toolCalls = 0;
  let totalCost = 0;
  let reportedCost = 0;
  let catalogCost = 0;
  let estimatedCost = 0;
  let unknownTokens = 0;
  let pricedTokens = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let durationTotal = 0;
  let durationCount = 0;
  const activeDates = new Set<string>();
  const sessionTokenTotals: number[] = [];
  const rootSessions = sessions.filter(
    (session) => !isSubagentSession(session),
  );

  for (const session of sessions) {
    conversationMessages += session.userMessages + session.assistantMessages;
    toolCalls += session.toolCalls.reduce((sum, tool) => sum + tool.count, 0);
    totalCost += session.totalTokens.cost.total;
    reportedCost += session.totalTokens.cost.reported ?? 0;
    catalogCost += session.totalTokens.cost.catalog ?? 0;
    estimatedCost += session.totalTokens.cost.estimated ?? 0;
    unknownTokens += session.totalTokens.cost.unknownTokens ?? 0;
    pricedTokens += session.totalTokens.cost.pricedTokens ?? 0;
    input += session.totalTokens.input;
    output += session.totalTokens.output;
    cacheRead += session.totalTokens.cacheRead;
    cacheWrite += session.totalTokens.cacheWrite;
    totalTokens += tokenBucketTotal(session.totalTokens);
  }

  for (const session of rootSessions) {
    const sessionTokens = tokenBucketTotal(session.totalTokens);
    sessionTokenTotals.push(sessionTokens);
    if (session.durationMs !== undefined) {
      durationTotal += session.durationMs;
      durationCount += 1;
    }
    const startedAt = parseDate(session.startTime);
    if (startedAt) activeDates.add(startedAt.toISOString().slice(0, 10));
  }

  const rootSessionCount = rootSessions.length;
  const tokenTotals = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      total: totalCost,
      reported: reportedCost,
      catalog: catalogCost,
      estimated: estimatedCost,
      unknownTokens,
      pricedTokens,
    },
  };

  return {
    rootSessionCount,
    subagentRuns: sessions.length - rootSessionCount,
    activeDays: activeDates.size,
    conversationMessages,
    toolCalls,
    totalCost,
    reportedCost,
    catalogCost,
    estimatedCost,
    unknownTokens,
    pricedTokens,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    tokenTotals,
    cacheReadShare: calculateCacheReadShare(input, cacheRead, cacheWrite),
    unknownPricingPercent: unknownPricingPercent(tokenTotals),
    pricingCoverage: pricingCoverage(tokenTotals),
    averageDurationMs:
      durationCount > 0 ? Math.round(durationTotal / durationCount) : -1,
    averageMessagesPerSession: Math.round(
      conversationMessages / Math.max(1, rootSessionCount),
    ),
    // Child usage remains in the total, but the denominator is root sessions.
    averageTokensPerSession: Math.round(
      totalTokens / Math.max(1, rootSessionCount),
    ),
    averageCostPerSession: totalCost / Math.max(1, rootSessionCount),
    medianTokens: median(sessionTokenTotals),
  };
}

type DashboardFrame = ReturnType<typeof createDashboardFrame>;

function addSection(
  lines: string[],
  frame: DashboardFrame,
  title: string,
  rows: readonly string[],
): void {
  if (rows.length === 0) return;
  lines.push(frame.section(title), ...rows);
}

function addMetricPair(
  rows: string[],
  frame: DashboardFrame,
  leftLabel: string,
  leftValue: number,
  rightLabel: string,
  rightValue: number,
): void {
  const leftVisible = leftValue > 0;
  const rightVisible = rightValue > 0;
  if (!leftVisible && !rightVisible) return;
  if (!rightVisible) {
    rows.push(frame.metric(leftLabel, formatNumber(leftValue)));
    return;
  }
  if (!leftVisible) {
    rows.push(frame.metric(rightLabel, formatNumber(rightValue)));
    return;
  }
  rows.push(
    frame.metricPair(
      leftLabel,
      formatNumber(leftValue),
      rightLabel,
      formatNumber(rightValue),
    ),
  );
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

function formatContextUsage(
  usage: CurrentContextUsage | undefined,
  theme: Theme | undefined,
): string | undefined {
  if (
    !usage ||
    usage.tokens === null ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0
  ) {
    return undefined;
  }
  const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
  return `${formatNumber(usage.tokens)} / ${formatNumber(usage.contextWindow)}  ${formatPercent(percent)}  ${progressBar(usage.tokens, usage.contextWindow, 10, theme, "accent")}`;
}

function estimatedCostLabel(cost: number): string {
  return cost > 0 ? "~" + fmtCost(cost) : "$0";
}

function formatDataQuality(
  quality: DataQuality,
  theme: Theme | undefined,
): string {
  const parsed = Math.max(0, quality.parsedSessions);
  const discovered = Math.max(parsed, quality.discoveredSessions);
  const coverage =
    discovered > 0
      ? ` · ${formatPercent((parsed / discovered) * 100)} coverage`
      : "";
  return color(
    theme,
    parsed < discovered ? "warning" : "dim",
    `Data: ${parsed}/${discovered} sessions parsed${coverage}`,
  );
}

function unknownPricingPercent(
  totals: Pick<TokenTotals, "totalTokens" | "cost">,
): number {
  const totalTokens = totals.totalTokens;
  const unknownTokens = totals.cost.unknownTokens ?? 0;
  return totalTokens > 0 ? (unknownTokens / totalTokens) * 100 : 0;
}

function pricingCoverage(
  totals: Pick<TokenTotals, "totalTokens" | "cost">,
): number {
  return 100 - unknownPricingPercent(totals);
}

function tokenBucketTotal(totals: SessionStats["totalTokens"]): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
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
