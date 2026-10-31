/**
 * Goal tools exposed to the model.
 *
 * Contracts mirror Codex: `get_goal`, `create_goal`, and `update_goal` with an
 * `update_goal` status enum of `complete | blocked | paused`. Rejections are
 * returned as error results so the model sees the reason and can keep working.
 */
import { Type } from "typebox";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { GoalHostApi } from "./host.ts";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { GoalToolCall, GoalToolPayload } from "../domain/goal.ts";
import type { GoalRuntime } from "../runtime.ts";
import { renderGoalUi } from "./pi-ui.ts";

const GoalObjectSchema = Type.Object({
    threadId: Type.String(),
    goalId: Type.String(),
    objective: Type.String(),
    status: Type.Union(
        ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].map(
            (status) => Type.Literal(status),
        ),
    ),
    tokenBudget: Type.Optional(Type.Number()),
    tokensUsed: Type.Number(),
    timeUsedSeconds: Type.Number(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
});

const GoalOutputSchema = Type.Object({
    goal: Type.Union([GoalObjectSchema, Type.Null()]),
    remainingTokens: Type.Union([Type.Number(), Type.Null()]),
    completionBudgetReport: Type.Union([Type.String(), Type.Null()]),
});

const CreateGoalParams = Type.Object({
    objective: Type.String({
        description:
            "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
    }),
    token_budget: Type.Optional(
        Type.Integer({
            description:
                "Positive token budget for the new goal. Omit unless explicitly requested.",
        }),
    ),
});

const UpdateGoalParams = Type.Object({
    status: Type.Union(
        [Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("paused")],
        {
            description:
                "Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
        },
    ),
    reason: Type.Optional(
        Type.String({
            description: "Short statement of the blocking condition or pause request.",
        }),
    ),
    evidence: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Current-state evidence for a blocked goal: failing command output, missing access, unresolved external dependency.",
        }),
    ),
});

/** Convert the engine payload into a value that satisfies Pi's `JsonValue`. */
function toJsonValue(payload: GoalToolPayload): JsonValue {
    if (payload.goal === null) {
        return {
            goal: null,
            remainingTokens: payload.remainingTokens,
            completionBudgetReport: payload.completionBudgetReport,
        };
    }
    const goal = payload.goal;
    return {
        goal: {
            threadId: goal.threadId,
            goalId: goal.goalId,
            objective: goal.objective,
            status: goal.status,
            ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
        },
        remainingTokens: payload.remainingTokens,
        completionBudgetReport: payload.completionBudgetReport,
    };
}

async function authorizeCreate(
    runtime: GoalRuntime,
    ctx: ExtensionToolContext,
    objective: string,
): Promise<boolean> {
    if (!ctx.hasUI) return runtime.config.allowUnattendedCreate;
    try {
        return await ctx.ui.confirm(
            "Create a goal?",
            `The model asked to create an autonomous goal that keeps working across turns:\n\n${objective}`,
        );
    } catch {
        return false;
    }
}

async function authorizePause(ctx: ExtensionToolContext): Promise<boolean> {
    if (!ctx.hasUI) return false;
    try {
        return await ctx.ui.confirm(
            "Pause this goal?",
            "The model asked to pause the active goal. The goal stops continuing until you run /goal resume.",
        );
    } catch {
        return false;
    }
}

async function runGoalTool(
    runtime: GoalRuntime,
    call: GoalToolCall,
    ctx: ExtensionToolContext,
) {
    const result = await runtime.run((engine) =>
        engine.runTool({ ...runtime.context(ctx), call }),
    );
    if (!result.ok) {
        return {
            content: [{ type: "text" as const, text: result.message }],
            details: { goal: null, remainingTokens: null, completionBudgetReport: null },
            isError: true,
        };
    }
    renderGoalUi(ctx, result.value.view);
    const payload = result.value.structured ?? {
        goal: null,
        remainingTokens: null,
        completionBudgetReport: null,
    };
    return {
        content: [{ type: "text" as const, text: result.value.message }],
        details: payload,
        structuredContent: toJsonValue(payload),
        isError: result.value.ok ? undefined : true,
    };
}

/** Register the three goal tools. */
export function registerGoalTools(pi: GoalHostApi, runtime: GoalRuntime): void {
    pi.registerTool({
        name: "get_goal",
        label: "Get goal",
        description:
            "Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.",
        parameters: Type.Object({}),
        outputSchema: GoalOutputSchema,
        execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) =>
            runGoalTool(runtime, { type: "get" }, ctx),
    });

    pi.registerTool({
        name: "create_goal",
        label: "Create goal",
        description:
            "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
        parameters: CreateGoalParams,
        outputSchema: GoalOutputSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const objective = typeof params.objective === "string" ? params.objective : "";
            if (!(await authorizeCreate(runtime, ctx, objective))) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Goal creation was not authorized. Ask the user to run /goal <objective> if they want an autonomous goal, or create it themselves.",
                        },
                    ],
                    details: { goal: null, remainingTokens: null, completionBudgetReport: null },
                    isError: true,
                };
            }
            return runGoalTool(
                runtime,
                {
                    type: "create",
                    objective,
                    budgetTokens:
                        typeof params.token_budget === "number" ? params.token_budget : null,
                },
                ctx,
            );
        },
    });

    pi.registerTool({
        name: "update_goal",
        label: "Update goal",
        description: [
            "Update the existing goal.",
            "Set status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.",
            "Set status to `complete` only when the objective has actually been achieved and no required work remains, backed by evidence you gathered in this goal turn.",
            "Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.",
            "If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.",
            "Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.",
            "Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
            "Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
            "You cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.",
            "When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
        ].join("\n"),
        parameters: UpdateGoalParams,
        outputSchema: GoalOutputSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const status = params.status;
            if (status !== "complete" && status !== "blocked" && status !== "paused") {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "update_goal accepts only complete, blocked, or paused.",
                        },
                    ],
                    details: { goal: null, remainingTokens: null, completionBudgetReport: null },
                    isError: true,
                };
            }
            if (status === "paused") {
                const authorized = await authorizePause(ctx);
                if (!authorized) {
                    return runGoalTool(
                        runtime,
                        { type: "update", status, reason: params.reason, pauseAuthorized: false },
                        ctx,
                    );
                }
            }
            return runGoalTool(
                runtime,
                {
                    type: "update",
                    status,
                    reason: params.reason,
                    evidence: params.evidence,
                    pauseAuthorized: status === "paused",
                },
                ctx,
            );
        },
    });
}
