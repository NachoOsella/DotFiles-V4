/** Aggregated model usage for a session. */
export interface ModelUsage {
  provider: string;
  modelId: string;
  count: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Aggregated model usage across one or more sessions. */
export interface AggregatedModelUsage {
  provider: string;
  modelId: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Aggregated tool-call usage. */
export interface ToolUsage {
  name: string;
  count: number;
}

/** Token and cost totals extracted from session messages. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

/** Statistics for one Pi session or the current in-memory branch. */
export interface SessionStats {
  file: string;
  name?: string;
  startTime?: string;
  durationMs?: number;
  totalTokens: TokenTotals;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  toolCalls: ToolUsage[];
  models: ModelUsage[];
  customMessages: number;
}

/** Minimal shape for session branch entries returned by Pi. */
export type SessionEntryLike = Record<string, any>;
