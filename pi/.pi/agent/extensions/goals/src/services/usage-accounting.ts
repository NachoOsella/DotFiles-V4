/**
 * Transcript-derived token accounting.
 *
 * Pure functions only: the caller supplies the branch, so the same derivation
 * runs in tests, in the engine, and after a reload. Every usage-bearing entry
 * kind Pi writes is counted once per entry id.
 */
import type { GoalUsageTotals, TranscriptEntry, UsageSnapshot } from "../domain/goal.ts";

/** Entry types that carry usage at the top level instead of on a message. */
const TOP_LEVEL_USAGE_TYPES = new Set(["usage", "compaction", "branch_summary"]);

export interface DeriveUsageInput {
    readonly branch: readonly TranscriptEntry[];
    /** Branch leaf at goal creation; entries up to and including it are not charged. */
    readonly usageStartEntryId: string | null;
}

export function emptyUsageTotals(): GoalUsageTotals {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        tokensUsed: 0,
        allTokens: 0,
        costTotal: 0,
    };
}

export function addUsageTotals(left: GoalUsageTotals, right: GoalUsageTotals): GoalUsageTotals {
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        reasoning: left.reasoning + right.reasoning,
        tokensUsed: left.tokensUsed + right.tokensUsed,
        allTokens: left.allTokens + right.allTokens,
        costTotal: left.costTotal + right.costTotal,
    };
}

/**
 * Billed tokens for one usage record.
 *
 * Pi reports cache buckets separately and `input` excludes them, so the Codex
 * charge `input - cached + output` maps to `input + cacheWrite + output`.
 * `cacheRead` is reported through `allTokens` but never billed again.
 */
export function chargeableTokens(usage: UsageSnapshot): number {
    return nonNegative(usage.input) + nonNegative(usage.cacheWrite) + nonNegative(usage.output);
}

/**
 * Sum usage for the goal span of a branch.
 *
 * Charging starts at the first entry after `usageStartEntryId`. When the anchor
 * is `null` or not on the branch, the whole branch is charged: the caller
 * treats a missing anchor as a fresh branch, so nothing is silently refunded.
 */
export function deriveUsage(input: DeriveUsageInput): GoalUsageTotals {
    const { branch, usageStartEntryId } = input;
    const anchorIndex =
        usageStartEntryId === null
            ? -1
            : branch.findIndex((entry) => entry.id === usageStartEntryId);

    const seen = new Set<string>();
    let totals = emptyUsageTotals();

    for (let index = anchorIndex + 1; index < branch.length; index += 1) {
        const entry = branch[index];
        const usage = readEntryUsage(entry);
        if (usage === null || seen.has(entry.id)) continue;
        seen.add(entry.id);
        totals = addUsageTotals(totals, usageToTotals(usage));
    }

    return totals;
}

/** Usage carried by one entry, or null when the entry reports none. */
function readEntryUsage(entry: TranscriptEntry): UsageSnapshot | null {
    if (TOP_LEVEL_USAGE_TYPES.has(entry.type)) {
        // Cache warming is background upkeep, not goal work.
        if (isCacheWarmEntry(entry)) return null;
        return isUsageSnapshot(entry.usage) ? entry.usage : null;
    }
    if (entry.type !== "message") return null;
    const message = entry.message;
    if (message === undefined) return null;
    if (message.role !== "assistant" && message.role !== "toolResult") return null;
    return isUsageSnapshot(message.usage) ? message.usage : null;
}

/** Turn one usage record into totals, keeping charge independent of totals math. */
function usageToTotals(usage: UsageSnapshot): GoalUsageTotals {
    const input = nonNegative(usage.input);
    const output = nonNegative(usage.output);
    const cacheRead = nonNegative(usage.cacheRead);
    const cacheWrite = nonNegative(usage.cacheWrite);
    const buckets = input + output + cacheRead + cacheWrite;
    if (buckets === 0) {
        const reported = nonNegative(usage.totalTokens ?? 0);
        if (reported > 0) {
            // A provider that reports only a total gives no cache split. Charge it
            // conservatively as non-cached input so a budget can still fire.
            return {
                input: reported,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                tokensUsed: reported,
                allTokens: reported,
                costTotal: nonNegative(usage.cost?.total ?? 0),
            };
        }
    }
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning: nonNegative(usage.reasoning ?? 0),
        tokensUsed: chargeableTokens(usage),
        allTokens: input + output + cacheRead + cacheWrite,
        costTotal: nonNegative(usage.cost?.total ?? 0),
    };
}

/** True for a cache-warming usage entry. */
function isCacheWarmEntry(entry: TranscriptEntry): boolean {
    if (entry.type !== "usage") return false;
    return Reflect.get(entry, "kind") === "cache_warm";
}

/** Treat absent, non-finite, and negative numbers as zero. */
function nonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Structural check for a usage record.
 *
 * Any numeric bucket or a numeric `totalTokens` is enough: `usageToTotals` treats
 * missing buckets as zero and falls back to the reported total, so a provider
 * that omits the split still gets charged.
 */
function isUsageSnapshot(value: unknown): value is UsageSnapshot {
    if (typeof value !== "object" || value === null) return false;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
        if (typeof Reflect.get(value, key) === "number") return true;
    }
    return false;
}
