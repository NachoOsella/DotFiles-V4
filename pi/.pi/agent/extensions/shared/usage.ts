import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Single definition of what a session's usage is and how it becomes cost.
 *
 * Shared by every extension that reports or renders usage: session-stats
 * (dashboards), model-info (footer billing), subagents (child accounting) and
 * ui-customization (footer labels). No extension owns this rule, so it lives
 * here instead of inside any one of them.
 */

/** Per-million-token model pricing rates. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelPricingTier[];
  /** Whether rates are catalog rates or a reference estimate for a free model. */
  source?: "catalog" | "estimated";
}

/** Alternate pricing rates selected for large requests. */
export interface ModelPricingTier extends Omit<ModelPricing, "tiers"> {
  inputTokensAbove: number;
}

/** Resolve pricing for a provider/model pair. */
export type ModelPricingResolver = (
  provider: string,
  modelId: string,
) => ModelPricing | undefined;

/** Source used to determine a model's cost. */
export type PricingSource =
  "reported" | "catalog" | "estimated" | "unknown" | "mixed";

/** Aggregated model usage for a session. */
export interface ModelUsage {
  provider: string;
  modelId: string;
  count: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Actual or catalog-calculated cost. Estimated value is tracked separately. */
  cost: number;
  reportedCost?: number;
  catalogCost?: number;
  estimatedCost?: number;
  /** Tokens whose pricing could not be identified for this model. */
  unknownTokens?: number;
  /** Token buckets with known reported, catalog, or estimated pricing. */
  pricedTokens?: number;
  /** Optional for compatibility with callers constructing test data. */
  pricingSource?: PricingSource;
}

/** Aggregated model usage across one or more sessions. */
export interface AggregatedModelUsage extends Omit<ModelUsage, "count"> {
  messages: number;
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
  /** Canonical accumulated usage: the four explicit token buckets above. */
  totalTokens: number;
  cost: {
    /** Actual or catalog-calculated cost; never includes estimated value. */
    total: number;
    reported?: number;
    catalog?: number;
    estimated?: number;
    unknownTokens?: number;
    pricedTokens?: number;
  };
  /** Provider-reported total retained only as diagnostic metadata. */
  reportedTotalTokens?: number;
  reportedTotalTokensMismatch?: number;
}

/** Statistics for one Pi session or the current in-memory branch. */
export interface SessionStats {
  file: string;
  /** Working directory associated with persisted sessions. */
  project?: string;
  /** Parent session path when Pi recorded this as a child session. */
  parentSessionPath?: string;
  /** Logical child identity from its persisted metadata. */
  agentPath?: string;
  /** Child rows already included in this root's totals. */
  subagents?: readonly SessionStats[];
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

/** Minimal safe shape accepted by the usage parser. */
export interface SessionEntryLike {
  type?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  name?: unknown;
  parentSession?: unknown;
  message?: unknown;
  usage?: unknown;
  provider?: unknown;
  model?: unknown;
  kind?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * Marks where a subagent's own work begins. Everything a child inherits from
 * its parent's fork sits before this entry and was already billed by the
 * parent, so it must never count toward the child's usage.
 */
export const SUBAGENT_OWN_USAGE_MARKER = "subagents-v3-agent-meta";

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
      cost: {
        total: 0,
        reported: 0,
        catalog: 0,
        estimated: 0,
        unknownTokens: 0,
        pricedTokens: 0,
      },
    },
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    toolCalls: [],
    models: [],
    customMessages: 0,
  };
}

/** Combine pricing sources across multiple requests for one model. */
export function combinePricingSources(
  current: PricingSource | undefined,
  next: PricingSource | undefined,
): PricingSource | undefined {
  if (!current) return next;
  if (!next || current === next) return current;
  return "mixed";
}

interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

/** Calculate USD from token usage and per-million-token model rates. */
export function calculateUsageCost(
  usage: UsageTokens,
  pricing: ModelPricing | undefined,
): number {
  if (!pricing) return 0;

  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates = pricing;
  let matchedThreshold = -1;
  for (const tier of pricing.tiers ?? []) {
    if (
      inputTokens > tier.inputTokensAbove &&
      tier.inputTokensAbove > matchedThreshold
    ) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }

  const cacheWrite1h = Math.min(
    Math.max(0, usage.cacheWrite1h ?? 0),
    usage.cacheWrite,
  );
  const shortCacheWrite = usage.cacheWrite - cacheWrite1h;

  // Anthropic charges 2x base input for cache entries retained for one hour.
  return (
    (rates.input * usage.input +
      rates.output * usage.output +
      rates.cacheRead * usage.cacheRead +
      rates.cacheWrite * shortCacheWrite +
      rates.input * 2 * cacheWrite1h) /
    1_000_000
  );
}

/** Paid catalog equivalents used to estimate the value of free endpoints. */
const FREE_MODEL_PRICE_REFERENCES: Record<string, readonly [string, string][]> =
  {
    "hy3-free": [["openrouter", "tencent/hy3"]],
    "mimo-v2-pro-free": [["opencode-go", "mimo-v2.5-pro"]],
    "nemotron-3-ultra-free": [["nvidia", "nvidia/nemotron-3-ultra-550b-a55b"]],
    "glm-4.7-free": [["openrouter", "z-ai/glm-4.7"]],
    "ling-2.6-flash-free": [["openrouter", "inclusionai/ling-2.6-flash"]],
    "trinity-large-preview-free": [
      ["vercel-ai-gateway", "arcee-ai/trinity-large-preview"],
    ],
  };

const pricingResolvers = new WeakMap<object, ModelPricingResolver>();

/** Resolve catalog rates once per registry, preserving free-model estimates. */
export function createModelPricingResolver(
  ctx: Pick<ExtensionContext, "modelRegistry">,
): ModelPricingResolver {
  const registry = ctx.modelRegistry as object;
  const cached = pricingResolvers.get(registry);
  if (cached) return cached;

  const resolver: ModelPricingResolver = (provider, modelId) => {
    const directModel = ctx.modelRegistry.find(provider, modelId);
    if (directModel) {
      // A zero-rate catalog entry is known free usage, not missing pricing.
      return { ...directModel.cost, source: "catalog" };
    }
    if (!modelId.endsWith("-free")) return undefined;

    const baseModelId = modelId.slice(0, -"-free".length);
    const candidates = [
      ["opencode", baseModelId] as const,
      ["opencode-go", baseModelId] as const,
      ...(FREE_MODEL_PRICE_REFERENCES[modelId] ?? []),
    ];
    for (const [referenceProvider, referenceModelId] of candidates) {
      const referenceModel = ctx.modelRegistry.find(
        referenceProvider,
        referenceModelId,
      );
      if (referenceModel && hasBillablePricing(referenceModel.cost)) {
        return { ...referenceModel.cost, source: "estimated" };
      }
    }

    // Do not present a free model's zero rate as a paid reference when no
    // equivalent exists; consumers show it as unknown instead.
    return undefined;
  };
  pricingResolvers.set(registry, resolver);
  return resolver;
}

function hasBillablePricing(pricing: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): boolean {
  return [
    pricing.input,
    pricing.output,
    pricing.cacheRead,
    pricing.cacheWrite,
  ].some((rate) => Number.isFinite(rate) && rate > 0);
}

/** Format USD cost with useful precision for small values. */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return "<$0.000001";
  if (usd < 0.01) return "$" + usd.toFixed(6);
  return "$" + usd.toFixed(2);
}

/**
 * Reconcile the explicit token buckets with the provider-reported total.
 * The explicit buckets stay authoritative; a mismatch is diagnostic only.
 */
export function finalizeTotalTokens(
  stats: SessionStats,
  reportedTotalTokens?: number,
): void {
  stats.totalTokens.totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.cacheRead +
    stats.totalTokens.cacheWrite;
  if (reportedTotalTokens !== undefined) {
    stats.totalTokens.reportedTotalTokens = reportedTotalTokens;
    stats.totalTokens.reportedTotalTokensMismatch =
      reportedTotalTokens - stats.totalTokens.totalTokens;
  }
}

/**
 * Accumulate usage for one session's entries.
 *
 * Every usage-bearing entry counts exactly once: assistant messages,
 * tool-result usage, attributed usage entries such as cache warming, and
 * compaction or branch-summary usage. Callers pass every persisted entry when
 * they want billed usage from abandoned branches too; live context occupancy
 * is reported separately by Pi's getContextUsage().
 */
export function parseSessionUsage(
  entries: readonly SessionEntryLike[],
  file: string,
  name?: string,
  pricing?: ModelPricingResolver,
): SessionStats {
  const stats = createEmptyStats(file, name);
  const collectors = createCollectors();
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  const agentPath = agentPathFromEntries(entries);
  if (agentPath !== undefined) stats.agentPath = agentPath;
  for (const entry of ownedSessionEntries(entries)) {
    const timestamp = parseTimestamp(entry.timestamp);
    firstTimestamp ??= timestamp;
    if (timestamp !== undefined) lastTimestamp = timestamp;
    if (entry.type === "session" && typeof entry.parentSession === "string") {
      stats.parentSessionPath = entry.parentSession;
    }
    if (entry.type !== "session")
      collectEntry(stats, collectors, entry, pricing);
  }

  if (firstTimestamp !== undefined)
    stats.startTime = new Date(firstTimestamp).toISOString();
  if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
    stats.durationMs = Math.max(0, lastTimestamp - firstTimestamp);
  }
  finishCollectors(stats, collectors);
  return stats;
}

/**
 * Entries a session billed for itself: everything after the ownership marker.
 * Exported so callers can apply the same boundary outside this module.
 */
export function ownedSessionEntries<T extends SessionEntryLike>(
  entries: readonly T[],
): readonly T[] {
  const boundary = entries.findIndex(
    (entry) =>
      entry.type === "custom" && entry.customType === SUBAGENT_OWN_USAGE_MARKER,
  );
  return boundary < 0 ? entries : entries.slice(boundary + 1);
}

/** Resolve the logical agent path recorded by the ownership marker. */
export function agentPathFromEntries(
  entries: readonly SessionEntryLike[],
): string | undefined {
  const marker = entries.find(
    (entry) =>
      entry.type === "custom" && entry.customType === SUBAGENT_OWN_USAGE_MARKER,
  );
  const path = (marker?.data as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

interface Collectors {
  readonly toolCalls: Map<string, number>;
  readonly models: Map<string, ModelUsage>;
  reportedTotalTokens: number;
  reportedTotalCount: number;
}

function createCollectors(): Collectors {
  return {
    toolCalls: new Map(),
    models: new Map(),
    reportedTotalTokens: 0,
    reportedTotalCount: 0,
  };
}

function collectEntry(
  stats: SessionStats,
  collectors: Collectors,
  entry: SessionEntryLike,
  pricing?: ModelPricingResolver,
): void {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    if (isRecord(entry.usage))
      collectUnattributedUsage(stats, collectors, entry.usage);
    return;
  }
  if (entry.type === "usage") {
    collectUsageEntry(stats, collectors, entry, pricing);
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
      collectNestedToolCalls(collectors.toolCalls, message.nestedCalls);
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
  const provider =
    typeof message.provider === "string" ? message.provider : undefined;
  const model = ensureModel(collectors.models, provider, modelId);
  if (model) model.count += 1;

  if (isRecord(message.usage)) {
    collectUsage(
      stats,
      collectors,
      message.usage,
      provider,
      modelId,
      model,
      pricingResolver,
    );
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (
      !isRecord(block) ||
      block.type !== "toolCall" ||
      typeof block.name !== "string"
    )
      continue;
    collectors.toolCalls.set(
      block.name,
      (collectors.toolCalls.get(block.name) ?? 0) + 1,
    );
  }
}

/**
 * Persisted usage that is not an assistant message, such as cache warming.
 * Pi records these entries with their provider and model so they stay
 * attributable; they count toward totals without adding a model response.
 */
function collectUsageEntry(
  stats: SessionStats,
  collectors: Collectors,
  entry: SessionEntryLike,
  pricingResolver?: ModelPricingResolver,
): void {
  if (!isRecord(entry.usage)) return;
  const provider =
    typeof entry.provider === "string" ? entry.provider : undefined;
  const modelId = typeof entry.model === "string" ? entry.model : undefined;
  if (!provider || !modelId) {
    collectUnattributedUsage(stats, collectors, entry.usage);
    return;
  }
  const model = ensureModel(collectors.models, provider, modelId);
  collectUsage(
    stats,
    collectors,
    entry.usage,
    provider,
    modelId,
    model,
    pricingResolver,
  );
}

function collectUsage(
  stats: SessionStats,
  collectors: Collectors,
  usage: Record<string, unknown>,
  provider: string | undefined,
  modelId: string | undefined,
  model: ModelUsage | undefined,
  pricingResolver?: ModelPricingResolver,
): void {
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const cacheWrite1h = finiteNumber(usage.cacheWrite1h);
  const pricing =
    provider && modelId ? pricingResolver?.(provider, modelId) : undefined;
  const cost = classifyUsageCost(
    usage,
    { input, output, cacheRead, cacheWrite, cacheWrite1h },
    pricing,
  );

  addUsageTotals(stats, collectors, usage, cost);
  if (!model) return;
  model.input += input;
  model.output += output;
  model.cacheRead += cacheRead;
  model.cacheWrite += cacheWrite;
  model.cost += cost.actual;
  model.reportedCost = (model.reportedCost ?? 0) + cost.reported;
  model.catalogCost = (model.catalogCost ?? 0) + cost.catalog;
  model.estimatedCost = (model.estimatedCost ?? 0) + cost.estimated;
  model.unknownTokens = (model.unknownTokens ?? 0) + cost.unknownTokens;
  model.pricedTokens = (model.pricedTokens ?? 0) + cost.pricedTokens;
  model.pricingSource = combinePricingSources(model.pricingSource, cost.source);
}

/**
 * Count nested tool calls (for example from codemode scripts) in the Tools
 * section. Pi keeps this bounded record on the calling tool's result because
 * nested calls never become transcript tool-call entries.
 */
function collectNestedToolCalls(
  toolCalls: Map<string, number>,
  nestedCalls: unknown,
): void {
  if (!isRecord(nestedCalls) || !Array.isArray(nestedCalls.calls)) return;
  for (const call of nestedCalls.calls) {
    if (!isRecord(call) || typeof call.name !== "string") continue;
    toolCalls.set(call.name, (toolCalls.get(call.name) ?? 0) + 1);
  }
}

function collectUnattributedUsage(
  stats: SessionStats,
  collectors: Collectors,
  usage: Record<string, unknown>,
): void {
  const cost = classifyUsageCost(usage, {
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    cacheRead: finiteNumber(usage.cacheRead),
    cacheWrite: finiteNumber(usage.cacheWrite),
  });
  addUsageTotals(stats, collectors, usage, cost);
}

interface UsageCost {
  actual: number;
  reported: number;
  catalog: number;
  estimated: number;
  unknownTokens: number;
  pricedTokens: number;
  source: PricingSource;
}

function classifyUsageCost(
  usage: Record<string, unknown>,
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
  },
  pricing?: ModelPricing,
): UsageCost {
  const tokenCount =
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const reportedCost = readReportedCost(usage);
  if (reportedCost !== undefined && reportedCost > 0) {
    return {
      actual: reportedCost,
      reported: reportedCost,
      catalog: 0,
      estimated: 0,
      unknownTokens: 0,
      pricedTokens: tokenCount,
      source: "reported",
    };
  }

  if (pricing) {
    const calculated = calculateUsageCost(tokens, pricing);
    if (pricing.source === "estimated") {
      return {
        actual: 0,
        reported: 0,
        catalog: 0,
        estimated: calculated,
        unknownTokens: 0,
        pricedTokens: tokenCount,
        source: "estimated",
      };
    }
    return {
      actual: calculated,
      reported: 0,
      catalog: calculated,
      estimated: 0,
      unknownTokens: 0,
      pricedTokens: tokenCount,
      source: "catalog",
    };
  }

  return {
    actual: 0,
    reported: 0,
    catalog: 0,
    estimated: 0,
    unknownTokens: tokenCount,
    pricedTokens: 0,
    source: "unknown",
  };
}

function addUsageTotals(
  stats: SessionStats,
  collectors: Collectors,
  usage: Record<string, unknown>,
  cost: UsageCost,
): void {
  stats.totalTokens.input += finiteNumber(usage.input);
  stats.totalTokens.output += finiteNumber(usage.output);
  stats.totalTokens.cacheRead += finiteNumber(usage.cacheRead);
  stats.totalTokens.cacheWrite += finiteNumber(usage.cacheWrite);
  stats.totalTokens.cost.total += cost.actual;
  stats.totalTokens.cost.reported =
    (stats.totalTokens.cost.reported ?? 0) + cost.reported;
  stats.totalTokens.cost.catalog =
    (stats.totalTokens.cost.catalog ?? 0) + cost.catalog;
  stats.totalTokens.cost.estimated =
    (stats.totalTokens.cost.estimated ?? 0) + cost.estimated;
  stats.totalTokens.cost.unknownTokens =
    (stats.totalTokens.cost.unknownTokens ?? 0) + cost.unknownTokens;
  stats.totalTokens.cost.pricedTokens =
    (stats.totalTokens.cost.pricedTokens ?? 0) + cost.pricedTokens;
  const reportedTotalTokens = readNumber(usage.totalTokens);
  if (reportedTotalTokens !== undefined) {
    collectors.reportedTotalTokens += reportedTotalTokens;
    collectors.reportedTotalCount += 1;
  }
}

function effectiveModelId(
  message: Record<string, unknown>,
): string | undefined {
  if (typeof message.responseModel === "string" && message.responseModel) {
    return message.responseModel;
  }
  return typeof message.model === "string" ? message.model : undefined;
}

function ensureModel(
  models: Map<string, ModelUsage>,
  provider: string | undefined,
  modelId: string | undefined,
): ModelUsage | undefined {
  if (!provider || !modelId) return undefined;
  const key = `${provider}/${modelId}`;
  const existing = models.get(key);
  if (existing) return existing;

  const model: ModelUsage = {
    provider,
    modelId,
    count: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    reportedCost: 0,
    catalogCost: 0,
    estimatedCost: 0,
    unknownTokens: 0,
    pricedTokens: 0,
  };
  models.set(key, model);
  return model;
}

function finishCollectors(stats: SessionStats, collectors: Collectors): void {
  stats.toolCalls = mapToolUsage(collectors.toolCalls);
  stats.models = [...collectors.models.values()].sort(
    (left, right) =>
      right.cost - left.cost ||
      right.input +
        right.output +
        right.cacheRead +
        right.cacheWrite -
        (left.input + left.output + left.cacheRead + left.cacheWrite) ||
      left.modelId.localeCompare(right.modelId),
  );
  finalizeTotalTokens(
    stats,
    collectors.reportedTotalCount > 0
      ? collectors.reportedTotalTokens
      : undefined,
  );
}

function mapToolUsage(toolCalls: ReadonlyMap<string, number>): ToolUsage[] {
  return [...toolCalls.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function finiteNumber(value: unknown): number {
  return readNumber(value) ?? 0;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readReportedCost(usage: Record<string, unknown>): number | undefined {
  return isRecord(usage.cost) ? readNumber(usage.cost.total) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
