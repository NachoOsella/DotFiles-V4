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

/** Minimal safe shape accepted by the session parser. */
export interface SessionEntryLike {
  type?: unknown;
  timestamp?: unknown;
  name?: unknown;
  parentSession?: unknown;
  message?: unknown;
  usage?: unknown;
}
