import { combinePricingSources } from "./pricing.ts";
import type {
  AggregatedModelUsage,
  ModelUsage,
  PricingSource,
  SessionStats,
  TokenTotals,
  ToolUsage,
} from "./types.ts";

/** Aggregate tool usage across sessions. */
export function buildToolUsage(sessions: readonly SessionStats[]): ToolUsage[] {
  const map = new Map<string, number>();
  for (const session of sessions) {
    for (const tool of session.toolCalls) {
      map.set(tool.name, (map.get(tool.name) ?? 0) + tool.count);
    }
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

/** Aggregate model usage across sessions while preserving pricing provenance. */
export function buildModelStats(
  sessions: readonly SessionStats[],
): AggregatedModelUsage[] {
  const map = new Map<string, AggregatedModelUsage>();
  for (const session of sessions) {
    for (const model of session.models) {
      const key = model.provider + "/" + model.modelId;
      const existing = map.get(key);
      if (existing) {
        addModelUsage(existing, model);
      } else {
        map.set(key, {
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
          pricedTokens:
            model.pricedTokens ??
            modelTokenCount(model) - (model.unknownTokens ?? 0),
          pricingSource: model.pricingSource,
        });
      }
    }
  }
  return Array.from(map.values()).sort(
    (left, right) =>
      right.messages - left.messages ||
      modelTokenCount(right) - modelTokenCount(left) ||
      left.modelId.localeCompare(right.modelId),
  );
}

/**
 * Return the portion of accumulated usage not represented by assistant model
 * rows. This keeps tool-result, compaction, and otherwise unattributed usage
 * visible instead of allowing the model table to undercount the total.
 */
export function buildUnattributedUsage(
  totals: TokenTotals,
  models: readonly AggregatedModelUsage[],
): AggregatedModelUsage | undefined {
  const modelInput = models.reduce((sum, model) => sum + model.input, 0);
  const modelOutput = models.reduce((sum, model) => sum + model.output, 0);
  const modelCacheRead = models.reduce(
    (sum, model) => sum + model.cacheRead,
    0,
  );
  const modelCacheWrite = models.reduce(
    (sum, model) => sum + model.cacheWrite,
    0,
  );
  const input = difference(totals.input, modelInput);
  const output = difference(totals.output, modelOutput);
  const cacheRead = difference(totals.cacheRead, modelCacheRead);
  const cacheWrite = difference(totals.cacheWrite, modelCacheWrite);
  const actualCost = difference(
    totals.cost.total,
    models.reduce((sum, model) => sum + model.cost, 0),
  );
  const reportedCost = difference(
    totals.cost.reported ?? 0,
    models.reduce((sum, model) => sum + (model.reportedCost ?? 0), 0),
  );
  const catalogCost = difference(
    totals.cost.catalog ?? 0,
    models.reduce((sum, model) => sum + (model.catalogCost ?? 0), 0),
  );
  const estimatedCost = difference(
    totals.cost.estimated ?? 0,
    models.reduce((sum, model) => sum + (model.estimatedCost ?? 0), 0),
  );
  const unknownTokens = difference(
    totals.cost.unknownTokens ?? 0,
    models.reduce((sum, model) => sum + (model.unknownTokens ?? 0), 0),
  );
  const tokenCount = input + output + cacheRead + cacheWrite;
  const pricedTokens = difference(
    totals.cost.pricedTokens ??
      tokenBucketTotal(totals) - (totals.cost.unknownTokens ?? 0),
    models.reduce(
      (sum, model) =>
        sum +
        (model.pricedTokens ??
          modelTokenCount(model) - (model.unknownTokens ?? 0)),
      0,
    ),
  );

  if (tokenCount === 0 && actualCost === 0 && estimatedCost === 0) {
    return undefined;
  }

  return {
    provider: "",
    modelId: "Tools & summaries",
    messages: 0,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: actualCost,
    reportedCost,
    catalogCost,
    estimatedCost,
    unknownTokens,
    pricedTokens: Math.max(0, pricedTokens),
    pricingSource: unattributedPricingSource(
      actualCost,
      estimatedCost,
      unknownTokens,
    ),
  };
}

/** Combine the current session with its persisted subagent sessions. */
export function mergeSessionStats(
  sessions: readonly SessionStats[],
  file: string,
  name?: string,
): SessionStats {
  const models = buildModelStats(sessions).map((model): ModelUsage => ({
    provider: model.provider,
    modelId: model.modelId,
    count: model.messages,
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
  const starts = sessions
    .map((session) => parseTimestamp(session.startTime))
    .filter((value): value is number => value !== undefined);
  const ends = sessions.flatMap((session) => {
    const start = parseTimestamp(session.startTime);
    return start === undefined
      ? []
      : [start + Math.max(0, session.durationMs ?? 0)];
  });

  const cost = sessions.reduce(
    (summary, session) => {
      summary.total += session.totalTokens.cost.total;
      summary.reported += session.totalTokens.cost.reported ?? 0;
      summary.catalog += session.totalTokens.cost.catalog ?? 0;
      summary.estimated += session.totalTokens.cost.estimated ?? 0;
      summary.unknownTokens += session.totalTokens.cost.unknownTokens ?? 0;
      summary.pricedTokens += session.totalTokens.cost.pricedTokens ?? 0;
      return summary;
    },
    {
      total: 0,
      reported: 0,
      catalog: 0,
      estimated: 0,
      unknownTokens: 0,
      pricedTokens: 0,
    },
  );
  const reportedTotalTokens = sessions.reduce(
    (sum, session) => sum + (session.totalTokens.reportedTotalTokens ?? 0),
    0,
  );
  const hasReportedTotalTokens = sessions.some(
    (session) => session.totalTokens.reportedTotalTokens !== undefined,
  );
  const input = sessions.reduce(
    (sum, session) => sum + session.totalTokens.input,
    0,
  );
  const output = sessions.reduce(
    (sum, session) => sum + session.totalTokens.output,
    0,
  );
  const cacheRead = sessions.reduce(
    (sum, session) => sum + session.totalTokens.cacheRead,
    0,
  );
  const cacheWrite = sessions.reduce(
    (sum, session) => sum + session.totalTokens.cacheWrite,
    0,
  );
  // Keep merged sessions on the same explicit-bucket canonical total as the parser.
  const totalTokens = input + output + cacheRead + cacheWrite;

  return {
    file,
    name,
    startTime:
      starts.length > 0
        ? new Date(Math.min(...starts)).toISOString()
        : undefined,
    // This is a session span from recorded timestamps, not active working time.
    durationMs:
      starts.length > 0 && ends.length > 0
        ? Math.max(...ends) - Math.min(...starts)
        : undefined,
    totalTokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost,
      ...(hasReportedTotalTokens
        ? {
            reportedTotalTokens,
            reportedTotalTokensMismatch: reportedTotalTokens - totalTokens,
          }
        : {}),
    },
    userMessages: sessions.reduce(
      (sum, session) => sum + session.userMessages,
      0,
    ),
    assistantMessages: sessions.reduce(
      (sum, session) => sum + session.assistantMessages,
      0,
    ),
    toolResults: sessions.reduce(
      (sum, session) => sum + session.toolResults,
      0,
    ),
    toolCalls: buildToolUsage(sessions),
    models,
    customMessages: sessions.reduce(
      (sum, session) => sum + session.customMessages,
      0,
    ),
  };
}

/** Return true for an explicitly linked or clearly named legacy subagent. */
export function isSubagentSession(
  session: Pick<SessionStats, "parentSessionPath" | "name">,
): boolean {
  return (
    Boolean(session.parentSessionPath) ||
    session.name?.startsWith("subagent:") === true
  );
}

function addModelUsage(target: AggregatedModelUsage, source: ModelUsage): void {
  const currentPricedTokens =
    target.pricedTokens ??
    modelTokenCount(target) - (target.unknownTokens ?? 0);
  const sourcePricedTokens =
    source.pricedTokens ??
    modelTokenCount(source) - (source.unknownTokens ?? 0);
  target.messages += source.count;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.reportedCost = (target.reportedCost ?? 0) + (source.reportedCost ?? 0);
  target.catalogCost = (target.catalogCost ?? 0) + (source.catalogCost ?? 0);
  target.estimatedCost =
    (target.estimatedCost ?? 0) + (source.estimatedCost ?? 0);
  target.unknownTokens =
    (target.unknownTokens ?? 0) + (source.unknownTokens ?? 0);
  target.pricedTokens = currentPricedTokens + sourcePricedTokens;
  target.pricingSource = combinePricingSources(
    target.pricingSource,
    source.pricingSource,
  );
}

function modelTokenCount(
  model: Pick<ModelUsage, "input" | "output" | "cacheRead" | "cacheWrite">,
): number {
  return model.input + model.output + model.cacheRead + model.cacheWrite;
}

function tokenBucketTotal(totals: TokenTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

function difference(total: number, represented: number): number {
  return Math.max(0, total - represented);
}

function unattributedPricingSource(
  actualCost: number,
  estimatedCost: number,
  unknownTokens: number,
) {
  let source: PricingSource | undefined =
    actualCost > 0 ? "reported" : undefined;
  if (estimatedCost > 0) source = combinePricingSources(source, "estimated");
  if (unknownTokens > 0) source = combinePricingSources(source, "unknown");
  return source;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
