/**
 * Pure continuation policy for the settlement boundary.
 *
 * The engine loads the authoritative view and passes it here; this module only
 * decides. It has no Effect, Pi, or I/O imports so every branch is directly
 * testable and the adapter owns persistence and notices.
 *
 * Decision order is significant and documented in `docs/ARCHITECTURE.md`:
 * lifecycle, interruptions and failures first, then the duplicate-boundary
 * guard, then the three breakers (idle, budget, turn cap), then continuation.
 */
import {
    isBudgetExhausted,
    type BoundaryFacts,
    type GoalView,
} from "../domain/goal.ts";
import type { TransitionCommand } from "../domain/transitions.ts";

export interface PolicyInput {
    readonly view: GoalView | null;
    readonly facts: BoundaryFacts;
    readonly maxGoalTurns: number;
    readonly maxIdleTurns: number;
    readonly buildContinuationPrompt: (view: GoalView) => string;
    readonly buildWrapUpPrompt: (view: GoalView, reason: "budget" | "turn-cap") => string;
}

export type PolicyOutcome =
    | { readonly kind: "idle"; readonly reason: string }
    | { readonly kind: "continue"; readonly reason: string; readonly prompt: string }
    | { readonly kind: "budget-wrapup"; readonly reason: string; readonly prompt: string }
    | {
          readonly kind: "transition";
          readonly reason: string;
          readonly command: TransitionCommand;
          readonly notice: string;
      };

/**
 * Provider failure patterns, checked in order: a quota message that also
 * mentions auth is a usage limit, not an auth failure.
 */
const USAGE_LIMIT_PATTERN =
    /usage limit|rate limit|quota|insufficient_quota|too many requests|credits?\b|billing|\b429\b/;
const AUTH_PATTERN = /unauthorized|invalid api key|authentication|invalid_api_key|\b401\b|\b403\b/;
const TRANSIENT_PATTERN =
    /\b5\d\d\b|overloaded|timeout|timed out|econnreset|econnrefused|socket hang up|network/;

/** Classify a provider error message; conservative, case-insensitive, never throws. */
export function classifyFailure(
    errorText: string | null,
): "usage-limit" | "auth" | "transient" | "unknown" {
    if (errorText === null) return "unknown";
    const text = errorText.toLowerCase();
    if (text.trim().length === 0) return "unknown";
    if (USAGE_LIMIT_PATTERN.test(text)) return "usage-limit";
    if (AUTH_PATTERN.test(text)) return "auth";
    if (TRANSIENT_PATTERN.test(text)) return "transient";
    return "unknown";
}

/** Keep provider error text short in persisted pause records and notices. */
function clip(text: string, limit = 200): string {
    const single = text.replace(/\s+/g, " ").trim();
    return single.length <= limit ? single : `${single.slice(0, limit - 3)}...`;
}

/** Decide what the goal does at one settlement boundary. First match wins. */
export function decideContinuation(input: PolicyInput): PolicyOutcome {
    const { view, facts } = input;

    if (view === null) return { kind: "idle", reason: "no-goal" };

    const status = view.snapshot.status;
    if (status !== "active") return { kind: "idle", reason: `inactive:${status}` };

    if (facts.outcome === "aborted") {
        return {
            kind: "transition",
            reason: "interrupted",
            command: { type: "interrupted" },
            notice: "Goal paused after interrupt. /goal resume to continue.",
        };
    }

    if (facts.outcome === "error") {
        const detail = facts.errorText;
        if (classifyFailure(detail) === "usage-limit") {
            return {
                kind: "transition",
                reason: "usage-limit",
                command: { type: "usage-limited", detail: detail ?? "" },
                notice:
                    "Provider usage limit reached. The goal is paused; wait for the limit to reset, then /goal resume to continue.",
            };
        }
        return {
            kind: "transition",
            reason: "provider-error",
            command: { type: "provider-error", detail: detail ?? "provider error" },
            notice: "The goal is paused after a provider error. Fix the failure, then /goal resume to continue.",
        };
    }

    const metrics = view.metrics;

    // The directive for this exact assistant entry is already on the branch, so
    // continuing would ask the model to redo work it has already been given.
    if (
        metrics.directivePending &&
        facts.assistantEntryId !== null &&
        metrics.lastDirectiveAnchorId === facts.assistantEntryId
    ) {
        return { kind: "idle", reason: "already-continued" };
    }

    const budgetTokens = view.snapshot.budgetTokens;
    const tokensUsed = metrics.usage.tokensUsed;
    if (isBudgetExhausted(budgetTokens, tokensUsed) && budgetTokens !== null) {
        if (metrics.wrapupCount === 0) {
            return {
                kind: "budget-wrapup",
                reason: "budget",
                prompt: input.buildWrapUpPrompt(view, "budget"),
            };
        }
        return {
            kind: "transition",
            reason: "budget",
            command: { type: "budget-exhausted" },
            notice: `Token budget exhausted: ${tokensUsed} of ${budgetTokens} tokens used. Raise the budget, then /goal resume to continue.`,
        };
    }

    if (metrics.idleTurns >= input.maxIdleTurns) {
        return {
            kind: "transition",
            reason: "no-progress",
            command: { type: "no-progress", idleTurns: metrics.idleTurns },
            notice: `No tool activity was observed for ${metrics.idleTurns} goal turns. The goal is paused; /goal resume to continue.`,
        };
    }

    if (metrics.auditedTurns >= input.maxGoalTurns) {
        if (metrics.wrapupCount === 0) {
            return {
                kind: "budget-wrapup",
                reason: "turn-cap",
                prompt: input.buildWrapUpPrompt(view, "turn-cap"),
            };
        }
        return {
            kind: "transition",
            reason: "turn-cap",
            command: {
                type: "pause",
                pauseReason: "turn-cap",
                detail: `${metrics.auditedTurns} of ${input.maxGoalTurns} goal turns`,
            },
            notice: `Goal turn cap reached: ${metrics.auditedTurns} of ${input.maxGoalTurns} goal turns used. The goal is paused; /goal resume grants a fresh turn allowance.`,
        };
    }

    return {
        kind: "continue",
        reason: "active",
        prompt: input.buildContinuationPrompt(view),
    };
}
