import { combinePricingSources } from "./pricing.ts";
import type {
  AggregatedModelUsage,
  ModelUsage,
  SessionStats,
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
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Aggregate model usage across sessions. */
export function buildModelStats(sessions: readonly SessionStats[]): AggregatedModelUsage[] {
  const map = new Map<string, AggregatedModelUsage>();
  for (const session of sessions) {
    for (const model of session.models) {
      const key = model.provider + "/" + model.modelId;
      const existing = map.get(key);
      if (existing) {
        existing.messages += model.count;
        existing.input += model.input;
        existing.output += model.output;
        existing.cacheRead += model.cacheRead;
        existing.cacheWrite += model.cacheWrite;
        existing.cost += model.cost;
        existing.pricingSource = combinePricingSources(
          existing.pricingSource,
          model.pricingSource,
        );
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
          pricingSource: model.pricingSource,
        });
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.messages - a.messages || a.modelId.localeCompare(b.modelId),
  );
}

/** Combine the current session with its persisted subagent sessions. */
export function mergeSessionStats(
  sessions: readonly SessionStats[],
  file: string,
  name?: string,
): SessionStats {
  const models = buildModelStats(sessions).map(
    (model): ModelUsage => ({
      provider: model.provider,
      modelId: model.modelId,
      count: model.messages,
      input: model.input,
      output: model.output,
      cacheRead: model.cacheRead,
      cacheWrite: model.cacheWrite,
      cost: model.cost,
      pricingSource: model.pricingSource,
    }),
  );
  const starts = sessions
    .map((session) => parseTimestamp(session.startTime))
    .filter((value): value is number => value !== undefined);
  const ends = sessions.flatMap((session) => {
    const start = parseTimestamp(session.startTime);
    return start === undefined ? [] : [start + Math.max(0, session.durationMs ?? 0)];
  });

  return {
    file,
    name,
    startTime:
      starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : undefined,
    durationMs:
      starts.length > 0 && ends.length > 0
        ? Math.max(...ends) - Math.min(...starts)
        : undefined,
    totalTokens: {
      input: sessions.reduce((sum, session) => sum + session.totalTokens.input, 0),
      output: sessions.reduce((sum, session) => sum + session.totalTokens.output, 0),
      cacheRead: sessions.reduce((sum, session) => sum + session.totalTokens.cacheRead, 0),
      cacheWrite: sessions.reduce((sum, session) => sum + session.totalTokens.cacheWrite, 0),
      totalTokens: sessions.reduce((sum, session) => sum + session.totalTokens.totalTokens, 0),
      cost: {
        total: sessions.reduce((sum, session) => sum + session.totalTokens.cost.total, 0),
      },
    },
    userMessages: sessions.reduce((sum, session) => sum + session.userMessages, 0),
    assistantMessages: sessions.reduce((sum, session) => sum + session.assistantMessages, 0),
    toolResults: sessions.reduce((sum, session) => sum + session.toolResults, 0),
    toolCalls: buildToolUsage(sessions),
    models,
    customMessages: sessions.reduce((sum, session) => sum + session.customMessages, 0),
  };
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
