import { readFile } from "node:fs/promises";
import { finalizeTotalTokens } from "./format.js";
import type { ModelUsage, SessionEntryLike, SessionStats, ToolUsage } from "./types.js";

/** Create an empty stats object for a session source. */
export function createEmptyStats(file: string, name?: string): SessionStats {
  return {
    file,
    name,
    startTime: undefined,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: [],
    models: [],
    customMessages: 0,
  };
}

/** Parse a persisted Pi JSONL session file into aggregate stats. */
export async function parseSessionFile(filePath: string): Promise<SessionStats> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const stats = createEmptyStats(filePath);
  const collectors = createCollectors();
  let firstTimestamp: string | undefined;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    let entry: SessionEntryLike;
    try {
      entry = JSON.parse(rawLine) as SessionEntryLike;
    } catch {
      continue;
    }

    if (entry.timestamp && !firstTimestamp) firstTimestamp = entry.timestamp;
    if (entry.type === "session") continue;
    collectEntry(stats, collectors, entry);
    if (entry.type === "session_info" && entry.name) stats.name = entry.name;
  }

  stats.startTime = firstTimestamp;
  finishCollectors(stats, collectors);
  return stats;
}

/** Parse the current in-memory branch from Pi's session manager. */
export function parseCurrentBranch(entries: SessionEntryLike[], file: string, name?: string): SessionStats {
  const stats = createEmptyStats(file, name);
  const collectors = createCollectors();
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const entry of entries) {
    if (entry.type === "session") {
      if (entry.timestamp) firstTs = new Date(entry.timestamp).getTime();
      continue;
    }
    if (!firstTs && entry.timestamp) firstTs = new Date(entry.timestamp).getTime();
    if (entry.timestamp) lastTs = new Date(entry.timestamp).getTime();
    collectEntry(stats, collectors, entry);
  }

  if (firstTs && lastTs) stats.durationMs = lastTs - firstTs;
  finishCollectors(stats, collectors);
  return stats;
}

interface Collectors {
  toolCallMap: Map<string, number>;
  modelMap: Map<string, ModelUsage>;
  reportedTotalTokens: number;
}

/** Create mutable maps used while parsing entries. */
function createCollectors(): Collectors {
  return {
    toolCallMap: new Map(),
    modelMap: new Map(),
    reportedTotalTokens: 0,
  };
}

/** Collect stats from one session entry. */
function collectEntry(stats: SessionStats, collectors: Collectors, entry: SessionEntryLike): void {
  if (entry.type !== "message" || !entry.message) return;
  const msg = entry.message;

  if (msg.role === "user") {
    stats.userMessages += 1;
  } else if (msg.role === "assistant") {
    collectAssistantMessage(stats, collectors, msg);
  } else if (msg.role === "toolResult") {
    stats.toolResults += 1;
  } else if (msg.role === "custom") {
    stats.customMessages += 1;
  }
}

/** Collect model, usage, and tool-call stats from one assistant message. */
function collectAssistantMessage(stats: SessionStats, collectors: Collectors, msg: any): void {
  stats.assistantMessages += 1;
  const model = ensureMessageModel(collectors.modelMap, msg);

  if (msg.usage) {
    const usage = msg.usage;
    stats.totalTokens.input += usage.input ?? 0;
    stats.totalTokens.output += usage.output ?? 0;
    stats.totalTokens.cacheRead += usage.cacheRead ?? 0;
    stats.totalTokens.cacheWrite += usage.cacheWrite ?? 0;
    collectors.reportedTotalTokens += usage.totalTokens ?? 0;
    stats.totalTokens.cost.total += usage.cost?.total ?? 0;

    if (model) {
      model.input += usage.input ?? 0;
      model.output += usage.output ?? 0;
      model.cacheRead += usage.cacheRead ?? 0;
      model.cacheWrite += usage.cacheWrite ?? 0;
      model.cost += usage.cost?.total ?? 0;
    }
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.name) {
        collectors.toolCallMap.set(block.name, (collectors.toolCallMap.get(block.name) ?? 0) + 1);
      }
    }
  }
}

/** Ensure a model usage collector exists for a message, if provider/model data is present. */
function ensureMessageModel(modelMap: Map<string, ModelUsage>, msg: any): ModelUsage | undefined {
  if (!msg.provider || !msg.model) return undefined;
  const key = msg.provider + "/" + msg.model;
  const existing = modelMap.get(key);
  if (existing) {
    existing.count += 1;
    return existing;
  }

  const model: ModelUsage = {
    provider: msg.provider,
    modelId: msg.model,
    count: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  modelMap.set(key, model);
  return model;
}

/** Move collected maps into sorted arrays and finalize token totals. */
function finishCollectors(stats: SessionStats, collectors: Collectors): void {
  stats.toolCalls = mapToolUsage(collectors.toolCallMap);
  stats.models = Array.from(collectors.modelMap.values()).sort((a, b) => b.count - a.count);
  finalizeTotalTokens(stats, collectors.reportedTotalTokens);
}

/** Convert a tool usage map into a sorted array. */
function mapToolUsage(toolCallMap: Map<string, number>): ToolUsage[] {
  return Array.from(toolCallMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
