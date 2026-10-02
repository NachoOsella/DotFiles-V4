import { parseCurrentBranch } from "../../session-stats/parser.ts";
import type {
  ModelPricingResolver,
  SessionEntryLike,
} from "../../session-stats/types.ts";

export interface SessionBilling {
  /** Cumulative cost of every billed entry on this session. */
  cost: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Parent-only cumulative billing and prompt-token buckets. The footer adds
 * logical child buckets and cost on top of these values.
 */
export function computeSessionBilling(
  entries: readonly SessionEntryLike[],
  pricing?: ModelPricingResolver,
): SessionBilling {
  const { totalTokens } = parseCurrentBranch(
    entries,
    "footer",
    undefined,
    pricing,
  );
  return {
    cost: totalTokens.cost.total,
    input: totalTokens.input,
    cacheRead: totalTokens.cacheRead,
    cacheWrite: totalTokens.cacheWrite,
  };
}

/** Cost-only view retained for callers that do not need token buckets. */
export function computeSessionCost(
  entries: readonly SessionEntryLike[],
  pricing?: ModelPricingResolver,
): number {
  return computeSessionBilling(entries, pricing).cost;
}
