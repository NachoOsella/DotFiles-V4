import type { AggregatedModelUsage, SessionStats, ToolUsage } from "./types.js";

/** Aggregate tool usage across sessions. */
export function buildToolUsage(sessions: SessionStats[]): ToolUsage[] {
  const map = new Map<string, number>();
  for (const session of sessions) {
    for (const tool of session.toolCalls) {
      map.set(tool.name, (map.get(tool.name) ?? 0) + tool.count);
    }
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** Aggregate model usage across sessions. */
export function buildModelStats(sessions: SessionStats[]): AggregatedModelUsage[] {
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
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.messages - a.messages);
}
