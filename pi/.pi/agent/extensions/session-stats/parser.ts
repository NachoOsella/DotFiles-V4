import { readFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import { finalizeTotalTokens } from "./format.ts";
import { calculateUsageCost, combinePricingSources } from "./pricing.ts";
import type {
  ModelPricingResolver,
  ModelUsage,
  PricingSource,
  SessionEntryLike,
  SessionStats,
  ToolUsage,
} from "./types.ts";

/** Identifies a session file that could not be read. */
export class SessionReadError extends Data.TaggedError("SessionReadError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/** Create an empty stats object for a session source. */
export function createEmptyStats(file: string, name?: string): SessionStats {
  return {
    file,
    name,
    totalTokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { total: 0 },
    },
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: [],
    models: [],
    customMessages: 0,
  };
}

/** Parse a persisted JSONL session as a composable Effect. */
export function parseSessionFileEffect(
  filePath: string,
  pricing?: ModelPricingResolver,
): Effect.Effect<SessionStats, SessionReadError> {
  return Effect.tryPromise({
    try: () => readFile(filePath, "utf8"),
    catch: (cause) => new SessionReadError({ path: filePath, cause }),
  }).pipe(Effect.map((content) => parseSessionText(content, filePath, pricing)));
}

/** Promise adapter retained for callers outside an Effect pipeline. */
export function parseSessionFile(
  filePath: string,
  pricing?: ModelPricingResolver,
): Promise<SessionStats> {
  return Effect.runPromise(parseSessionFileEffect(filePath, pricing));
}

/** Parse in-memory entries from Pi's current session. */
export function parseCurrentBranch(
  entries: readonly SessionEntryLike[],
  file: string,
  name?: string,
  pricing?: ModelPricingResolver,
): SessionStats {
  const stats = createEmptyStats(file, name);
  const collectors = createCollectors();
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  for (const entry of entries) {
    const timestamp = parseTimestamp(entry.timestamp);
    firstTimestamp ??= timestamp;
    if (timestamp !== undefined) lastTimestamp = timestamp;
    if (entry.type !== "session") collectEntry(stats, collectors, entry, pricing);
  }

  if (firstTimestamp !== undefined) stats.startTime = new Date(firstTimestamp).toISOString();
  if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
    stats.durationMs = Math.max(0, lastTimestamp - firstTimestamp);
  }
  finishCollectors(stats, collectors);
  return stats;
}

function parseSessionText(
  content: string,
  filePath: string,
  pricing?: ModelPricingResolver,
): SessionStats {
  const stats = createEmptyStats(filePath);
  const collectors = createCollectors();
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  for (const line of content.split(/\r?\n/)) {
    const entry = parseEntry(line);
    if (!entry) continue;

    const timestamp = parseTimestamp(entry.timestamp);
    firstTimestamp ??= timestamp;
    if (timestamp !== undefined) lastTimestamp = timestamp;
    if (entry.type === "session_info" && typeof entry.name === "string") {
      stats.name = entry.name;
    }
    if (entry.type !== "session") collectEntry(stats, collectors, entry, pricing);
  }

  if (firstTimestamp !== undefined) stats.startTime = new Date(firstTimestamp).toISOString();
  if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
    stats.durationMs = Math.max(0, lastTimestamp - firstTimestamp);
  }
  finishCollectors(stats, collectors);
  return stats;
}

interface Collectors {
  readonly toolCalls: Map<string, number>;
  readonly models: Map<string, ModelUsage>;
  reportedTotalTokens: number;
}

function createCollectors(): Collectors {
  return { toolCalls: new Map(), models: new Map(), reportedTotalTokens: 0 };
}

function collectEntry(
  stats: SessionStats,
  collectors: Collectors,
  entry: SessionEntryLike,
  pricing?: ModelPricingResolver,
): void {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    if (isRecord(entry.usage)) collectUnattributedUsage(stats, collectors, entry.usage);
    return;
  }
  if (entry.type === "custom_message") {
    stats.customMessages += 1;
    return;
  }
  if (entry.type !== "message" || !isRecord(entry.message)) return;
  const message = entry.message;

  switch (message.role) {
    case "user":
      stats.userMessages += 1;
      break;
    case "assistant":
      collectAssistantMessage(stats, collectors, message, pricing);
      break;
    case "toolResult":
      stats.toolResults += 1;
      if (isRecord(message.usage)) {
        collectUnattributedUsage(stats, collectors, message.usage);
      }
      break;
    case "custom":
      stats.customMessages += 1;
      break;
  }
}

function collectAssistantMessage(
  stats: SessionStats,
  collectors: Collectors,
  message: Record<string, unknown>,
  pricingResolver?: ModelPricingResolver,
): void {
  stats.assistantMessages += 1;
  const modelId = effectiveModelId(message);
  const model = ensureMessageModel(collectors.models, message, modelId);
  const usage = isRecord(message.usage) ? message.usage : undefined;

  if (usage) {
    const input = finiteNumber(usage.input);
    const output = finiteNumber(usage.output);
    const cacheRead = finiteNumber(usage.cacheRead);
    const cacheWrite = finiteNumber(usage.cacheWrite);
    const cacheWrite1h = finiteNumber(usage.cacheWrite1h);
    const reportedCost = isRecord(usage.cost) ? finiteNumber(usage.cost.total) : 0;
    const provider = typeof message.provider === "string" ? message.provider : undefined;
    const pricing =
      provider && modelId ? pricingResolver?.(provider, modelId) : undefined;
    const pricingSource: PricingSource =
      reportedCost > 0
        ? "reported"
        : pricing?.source ?? (pricing ? "catalog" : "unknown");
    const cost =
      reportedCost > 0
        ? reportedCost
        : calculateUsageCost(
            { input, output, cacheRead, cacheWrite, cacheWrite1h },
            pricing,
          );

    addUsageTotals(stats, collectors, usage, cost);
    if (model) {
      model.input += input;
      model.output += output;
      model.cacheRead += cacheRead;
      model.cacheWrite += cacheWrite;
      model.cost += cost;
      model.pricingSource = combinePricingSources(
        model.pricingSource,
        pricingSource,
      );
    }
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
    collectors.toolCalls.set(block.name, (collectors.toolCalls.get(block.name) ?? 0) + 1);
  }
}

function collectUnattributedUsage(
  stats: SessionStats,
  collectors: Collectors,
  usage: Record<string, unknown>,
): void {
  const reportedCost = isRecord(usage.cost) ? finiteNumber(usage.cost.total) : 0;
  addUsageTotals(stats, collectors, usage, reportedCost);
}

function addUsageTotals(
  stats: SessionStats,
  collectors: Collectors,
  usage: Record<string, unknown>,
  cost: number,
): void {
  stats.totalTokens.input += finiteNumber(usage.input);
  stats.totalTokens.output += finiteNumber(usage.output);
  stats.totalTokens.cacheRead += finiteNumber(usage.cacheRead);
  stats.totalTokens.cacheWrite += finiteNumber(usage.cacheWrite);
  stats.totalTokens.cost.total += cost;
  collectors.reportedTotalTokens += finiteNumber(usage.totalTokens);
}

function effectiveModelId(message: Record<string, unknown>): string | undefined {
  if (typeof message.responseModel === "string" && message.responseModel) {
    return message.responseModel;
  }
  return typeof message.model === "string" ? message.model : undefined;
}

function ensureMessageModel(
  models: Map<string, ModelUsage>,
  message: Record<string, unknown>,
  modelId: string | undefined,
): ModelUsage | undefined {
  if (typeof message.provider !== "string" || !modelId) return undefined;
  const key = `${message.provider}/${modelId}`;
  const existing = models.get(key);
  if (existing) {
    existing.count += 1;
    return existing;
  }

  const model: ModelUsage = {
    provider: message.provider,
    modelId,
    count: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  models.set(key, model);
  return model;
}

function finishCollectors(stats: SessionStats, collectors: Collectors): void {
  stats.toolCalls = mapToolUsage(collectors.toolCalls);
  stats.models = [...collectors.models.values()].sort((left, right) => right.count - left.count);
  finalizeTotalTokens(stats, collectors.reportedTotalTokens);
}

function mapToolUsage(toolCalls: ReadonlyMap<string, number>): ToolUsage[] {
  return [...toolCalls.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function parseEntry(line: string): SessionEntryLike | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
