import type { ModelPricing, PricingSource } from "./types.ts";

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
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
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
    rates.input * usage.input +
    rates.output * usage.output +
    rates.cacheRead * usage.cacheRead +
    rates.cacheWrite * shortCacheWrite +
    rates.input * 2 * cacheWrite1h
  ) / 1_000_000;
}
