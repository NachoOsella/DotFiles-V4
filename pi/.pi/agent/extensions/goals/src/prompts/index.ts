/**
 * Prompt builders. Every model-visible goal text is produced here so the
 * adapter never assembles strings itself.
 */
export {
    buildContinuationPrompt,
    buildKickoffPrompt,
    escapeObjective,
    formatBudget,
    renderTemplate,
    wrapGoalContext,
} from "./continuation.ts";
export type { BudgetRendering, ContinuationPromptInput } from "./continuation.ts";
export { buildBudgetWrapUpPrompt, buildTurnCapWrapUpPrompt } from "./budget-limit.ts";
export type { BudgetWrapUpInput } from "./budget-limit.ts";
export { buildObjectiveUpdatedPrompt } from "./objective.ts";
export type { ObjectiveUpdatedInput } from "./objective.ts";
export {
    buildBlockedRejectedMessage,
    buildCompletionRejectedMessage,
    buildCompletionReport,
    buildPauseUnauthorizedMessage,
} from "./messages.ts";
