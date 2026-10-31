/**
 * Model-facing rejection and completion messages.
 *
 * The rejection texts are ours: they explain the deterministic gates that
 * Codex leaves to prompt discipline. The completion report keeps the Codex
 * `completionBudgetReport` string above a compact usage line.
 */
import type { GoalView } from "../domain/goal.ts";

/**
 * Codex `goal/src/tool.rs` completion report, verbatim. The usage line added
 * below it is Pi-specific because the tool result carries the numbers already.
 */
const COMPLETION_REPORT =
    "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language.";

/** `update_goal` with `complete` found no successful tool result this turn. */
export function buildCompletionRejectedMessage(input: { readonly evidenceCount: number }): string {
    return [
        `Completion rejected: update_goal with status "complete" requires evidence from the current goal turn, but the turn has ${input.evidenceCount} successful tool results.`,
        "",
        "Completion is a claim that the full objective is finished, so it must survive the audit in the goal prompt: derive the requirements from the objective and everything it references, then prove each explicit requirement, numbered item, named artifact, command, test, gate, invariant, and deliverable from authoritative current state. Missing, weak, indirect, or merely consistent evidence means the goal is not achieved.",
        "",
        "Verify the objective with real commands and reads now, inspect their output, and then call update_goal with status \"complete\" again once current evidence proves that no required work remains.",
    ].join("\n");
}

/** `update_goal` with `blocked` before the three-turn audit threshold. */
export function buildBlockedRejectedMessage(input: {
    readonly auditedTurns: number;
    readonly requiredTurns: number;
}): string {
    return [
        `Blocked rejected: update_goal with status "blocked" requires the same blocking condition to repeat for at least ${input.requiredTurns} consecutive goal turns, counted from the current resume baseline. The current count is ${input.auditedTurns} of ${input.requiredTurns}.`,
        "",
        "If progress is still possible, keep working toward the objective and leave the goal active. If the same genuine blocker recurs across turns, report it and retry once the count reaches the threshold.",
    ].join("\n");
}

/** `update_goal` with `paused` without an explicit user request. */
export function buildPauseUnauthorizedMessage(): string {
    return [
        "Pause rejected: a goal may be paused only when the user explicitly requests it, and this pause was not authorized by the user.",
        "",
        "Ask the user to authorize the pause, which the adapter confirms before applying it, or have the user run /goal pause. Until then, keep working toward the active goal.",
    ].join("\n");
}

/** Completion report: Codex audit text plus current usage. */
export function buildCompletionReport(view: GoalView): string {
    const { metrics, snapshot } = view;
    const budget = snapshot.budgetTokens === null ? "unbounded" : String(snapshot.budgetTokens);
    const seconds = Math.floor(metrics.activeMs / 1000);
    const usage = [
        `tokens used ${metrics.usage.tokensUsed}`,
        `token budget ${budget}`,
        `all tokens ${metrics.usage.allTokens}`,
        `elapsed ${seconds} seconds`,
    ].join(", ");
    return `${COMPLETION_REPORT}\n\nUsage: ${usage}.`;
}
