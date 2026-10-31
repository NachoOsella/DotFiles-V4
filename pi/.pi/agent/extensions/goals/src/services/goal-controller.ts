/**
 * Goal engine: the only stateful decision point of the extension.
 *
 * The transcript is the source of truth. Every call reads the branch, derives
 * metrics, applies at most a couple of transitions, persists the resulting
 * snapshot, and returns a decision. The engine keeps no long-lived state of its
 * own; a single permit serializes read-modify-write sections so parallel tool
 * calls cannot interleave snapshots.
 */
import { Context, Effect, Layer, Semaphore } from "effect";
import {
    DEFAULT_MAX_GOAL_TURNS,
    DEFAULT_MAX_IDLE_TURNS,
    MIN_BLOCKED_AUDIT_TURNS,
    remainingTokens,
    type BoundaryDecision,
    type BoundaryFacts,
    type GoalActionResult,
    type GoalContextInput,
    type GoalLoadIssue,
    type GoalMetrics,
    type GoalSnapshot,
    type GoalToolCall,
    type GoalToolPayload,
    type GoalView,
    type TranscriptEntry,
    type UserCommand,
} from "../domain/goal.ts";
import {
    GoalNotFoundError,
    GoalRejectedError,
    type GoalError,
} from "../domain/errors.ts";
import type { GoalEvent } from "../domain/events.ts";
import { transition, type TransitionCommand } from "../domain/transitions.ts";
import { deriveUsage } from "./usage-accounting.ts";
import { deriveTurnStats } from "./progress-tracker.ts";
import { decideContinuation } from "./continuation-policy.ts";
import { loadLatestSnapshot, persistCleared, persistSnapshot } from "./goal-repository.ts";
import { buildContinuationPrompt, buildKickoffPrompt } from "../prompts/continuation.ts";
import { buildBudgetWrapUpPrompt, buildTurnCapWrapUpPrompt } from "../prompts/budget-limit.ts";
import { buildObjectiveUpdatedPrompt } from "../prompts/objective.ts";
import {
    buildBlockedRejectedMessage,
    buildCompletionRejectedMessage,
    buildCompletionReport,
    buildPauseUnauthorizedMessage,
} from "../prompts/messages.ts";

/** Why a runtime created the engine. Mirrors Pi's `session_start` reasons. */
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork" | "tree";

/** Engine tuning. Defaults are production values; tests override them. */
export interface GoalEngineOptions {
    readonly maxGoalTurns?: number;
    readonly maxIdleTurns?: number;
    readonly maxBudgetTokens?: number;
    readonly generateGoalId?: () => string;
}

const DEFAULT_MAX_BUDGET_TOKENS = 2_000_000;

export interface GoalViewResult {
    readonly view: GoalView | null;
    readonly issues: readonly GoalLoadIssue[];
    readonly entryId: string | null;
}

export interface SettleInput {
    readonly aborted: boolean;
    /** Wall-clock milliseconds the finished run spent while the goal was active. */
    readonly activeMsDelta: number;
}

export interface SettleResult {
    readonly view: GoalView | null;
    readonly notice: string | null;
}

export interface RehydrateInput {
    readonly reason: SessionStartReason;
}

export interface BoundaryInput {
    readonly facts: BoundaryFacts;
}

/** Engine surface consumed by the Pi adapters. */
export interface GoalEngineShape {
    readonly view: (input: GoalContextInput) => Effect.Effect<GoalViewResult>;
    readonly rehydrate: (
        input: GoalContextInput & RehydrateInput,
    ) => Effect.Effect<GoalActionResult>;
    readonly decideBoundary: (
        input: GoalContextInput & BoundaryInput,
    ) => Effect.Effect<BoundaryDecision>;
    readonly settle: (input: GoalContextInput & SettleInput) => Effect.Effect<SettleResult>;
    /** Best-effort pause after an internal failure so no goal stays active unserved. */
    readonly failSafe: (
        input: GoalContextInput & { readonly detail: string },
    ) => Effect.Effect<GoalActionResult>;
    readonly runCommand: (
        input: GoalContextInput & { readonly command: UserCommand },
    ) => Effect.Effect<GoalActionResult, GoalError>;
    readonly runTool: (
        input: GoalContextInput & { readonly call: GoalToolCall },
    ) => Effect.Effect<GoalActionResult, GoalError>;
}

export class GoalEngine extends Context.Service<GoalEngine, GoalEngineShape>()(
    "goals/GoalEngine",
) {}

/** Derive the full view from a snapshot and the branch it belongs to. */
export function deriveGoalView(
    snapshot: GoalSnapshot,
    branch: readonly TranscriptEntry[],
): GoalView {
    const usage = deriveUsage({ branch, usageStartEntryId: snapshot.usageStartEntryId });
    const turns = deriveTurnStats(branch, snapshot.goalId);
    const metrics: GoalMetrics = {
        usage,
        remainingTokens: remainingTokens(snapshot.budgetTokens, usage.tokensUsed),
        goalTurns: turns.goalTurns,
        auditedTurns: Math.max(0, turns.goalTurns - snapshot.turnBaseline),
        continuationCount: turns.continuationCount,
        wrapupCount: turns.wrapupCount,
        toolCalls: turns.toolCalls,
        failedToolCalls: turns.failedToolCalls,
        currentTurnEvidence: turns.currentTurnEvidence,
        currentTurnMutated: turns.currentTurnMutated,
        idleTurns: turns.idleTurns,
        activeMs: snapshot.activeMs,
        directivePending: turns.directivePending,
        lastDirectiveEntryId: turns.lastDirectiveEntryId,
        lastDirectiveAnchorId: turns.lastDirectiveAnchorId,
    };
    return { snapshot, metrics };
}

/**
 * Report active time including the run in flight. Used only for tool payloads
 * and messages; settlement persists the authoritative total.
 */
export function withElapsedActiveMs(view: GoalView | null, elapsedMs: number | undefined): GoalView | null {
    if (view === null || elapsedMs === undefined || elapsedMs <= 0) return view;
    return {
        snapshot: { ...view.snapshot, activeMs: view.snapshot.activeMs + elapsedMs },
        metrics: { ...view.metrics, activeMs: view.metrics.activeMs + elapsedMs },
    };
}

/** Codex-compatible structured payload for the goal tools. */
export function buildToolPayload(view: GoalView | null): GoalToolPayload {
    if (!view) {
        return { goal: null, remainingTokens: null, completionBudgetReport: null };
    }
    const { snapshot, metrics } = view;
    const base = {
        // Codex calls this `threadId`; Pi's analog is the session, and the goal id
        // is added so the extension's identity is visible too.
        threadId: snapshot.sessionId,
        goalId: snapshot.goalId,
        objective: snapshot.objective,
        status: snapshot.status,
        tokensUsed: metrics.usage.tokensUsed,
        timeUsedSeconds: Math.floor(snapshot.activeMs / 1000),
        createdAt: Math.floor(snapshot.createdAt / 1000),
        updatedAt: Math.floor(snapshot.updatedAt / 1000),
    };
    return {
        goal:
            snapshot.budgetTokens === null
                ? base
                : { ...base, tokenBudget: snapshot.budgetTokens },
        remainingTokens: metrics.remainingTokens,
        completionBudgetReport:
            snapshot.status === "complete" &&
            (snapshot.budgetTokens !== null || snapshot.activeMs > 0)
                ? buildCompletionReport(view)
                : null,
    };
}

/** Compact one-line summary used by tools and the `/goal` command. */
export function summarizeView(view: GoalView): string {
    const { snapshot, metrics } = view;
    const budget =
        snapshot.budgetTokens === null
            ? "unbounded"
            : `${metrics.usage.tokensUsed}/${snapshot.budgetTokens}`;
    return [
        `status=${snapshot.status}`,
        `objective="${truncate(snapshot.objective, 120)}"`,
        `tokens=${budget}`,
        `turns=${metrics.goalTurns}`,
        `continuations=${metrics.continuationCount}`,
        `tools=${metrics.toolCalls}(${metrics.failedToolCalls} failed)`,
        `active=${Math.floor(snapshot.activeMs / 1000)}s`,
    ].join(" ");
}

function truncate(value: string, limit: number): string {
    const single = value.replace(/\s+/g, " ").trim();
    return single.length <= limit ? single : `${single.slice(0, Math.max(0, limit - 3))}...`;
}

/** Last entry id of the branch, used as the usage anchor for a new goal. */
export function currentLeafId(branch: readonly TranscriptEntry[]): string | null {
    return branch.length === 0 ? null : branch[branch.length - 1].id;
}

function continuationPrompt(view: GoalView): string {
    return buildContinuationPrompt({
        objective: view.snapshot.objective,
        tokensUsed: view.metrics.usage.tokensUsed,
        budgetTokens: view.snapshot.budgetTokens,
        remainingTokens: view.metrics.remainingTokens,
        goalTurns: view.metrics.goalTurns,
        status: view.snapshot.status,
    });
}

/** Build the engine layer with a fixed configuration. */
export function makeGoalEngineLayer(
    options: GoalEngineOptions = {},
): Layer.Layer<GoalEngine> {
    const maxGoalTurns = options.maxGoalTurns ?? DEFAULT_MAX_GOAL_TURNS;
    const maxIdleTurns = options.maxIdleTurns ?? DEFAULT_MAX_IDLE_TURNS;
    const maxBudgetTokens = options.maxBudgetTokens ?? DEFAULT_MAX_BUDGET_TOKENS;
    const generateGoalId = options.generateGoalId ?? (() => globalThis.crypto.randomUUID());

    return Layer.effect(
        GoalEngine,
        Effect.gen(function* () {
            const gate = Semaphore.makeUnsafe(1);

            const transitionContext = (
                snapshot: GoalSnapshot | null,
                input: GoalContextInput,
                branch: readonly TranscriptEntry[],
                goalTurns: number,
                freshAnchor: boolean,
            ) => ({
                now: input.now,
                goalId: snapshot?.goalId ?? generateGoalId(),
                sessionId: input.sessionId,
                usageStartEntryId:
                    freshAnchor
                        ? currentLeafId(branch)
                        : snapshot?.usageStartEntryId ?? currentLeafId(branch),
                goalTurns: snapshot === null ? 0 : goalTurns,
                tokensUsed:
                    snapshot === null
                        ? 0
                        : deriveUsage({
                              branch,
                              usageStartEntryId: snapshot.usageStartEntryId,
                          }).tokensUsed,
            });

            const runTransition = (
                snapshot: GoalSnapshot | null,
                command: TransitionCommand,
                input: GoalContextInput,
                branch: readonly TranscriptEntry[],
                options: { readonly freshAnchor?: boolean } = {},
            ): Effect.Effect<
                { snapshot: GoalSnapshot | null; events: readonly GoalEvent[] },
                GoalError
            > =>
                Effect.gen(function* () {
                    const goalTurns =
                        snapshot === null
                            ? 0
                            : deriveTurnStats(branch, snapshot.goalId).goalTurns;
                    const result = transition(
                        snapshot,
                        command,
                        transitionContext(
                            snapshot,
                            input,
                            branch,
                            goalTurns,
                            options.freshAnchor === true,
                        ),
                    );
                    if (!result.ok) {
                        return yield* Effect.fail(result.error);
                    }
                    const next = result.outcome.snapshot;
                    // A no-op transition returns the same snapshot instance; do not
                    // append a duplicate entry for it.
                    if (next !== null && next !== snapshot) {
                        yield* persistSnapshot(input.appendEntry, next);
                    }
                    return { snapshot: next, events: result.outcome.events };
                });

            /** Run a transition, converting a typed rejection into a `failure` string. */
            const tryTransition = (
                effect: Effect.Effect<
                    { snapshot: GoalSnapshot | null; events: readonly GoalEvent[] },
                    GoalError
                >,
            ): Effect.Effect<{
                snapshot: GoalSnapshot | null;
                events: readonly GoalEvent[];
                failure: string | null;
            }> =>
                effect.pipe(
                    Effect.map((value) => ({ ...value, failure: null })),
                    Effect.catch((error: GoalError) =>
                        Effect.succeed({
                            snapshot: null,
                            events: [] as readonly GoalEvent[],
                            failure: error.message,
                        }),
                    ),
                );

            const load = (input: GoalContextInput) => {
                const branch = input.readBranch();
                const loaded = loadLatestSnapshot(branch);
                const view = loaded.snapshot ? deriveGoalView(loaded.snapshot, branch) : null;
                return { branch, loaded, view };
            };

            const budgetTooLarge = (budgetTokens: number | null): GoalError | null =>
                budgetTokens !== null && budgetTokens > maxBudgetTokens
                    ? new GoalRejectedError({
                          message: `goal token budget ${budgetTokens} exceeds the maximum allowed goal token budget of ${maxBudgetTokens}`,
                          code: "invalid-budget",
                      })
                    : null;

            const clipped = (text: string, limit = 200): string => {
                const single = text.replace(/\s+/g, " ").trim();
                return single.length <= limit ? single : `${single.slice(0, limit - 3)}...`;
            };

            const resultFor = (
                message: string,
                view: GoalView | null,
                extra: Partial<GoalActionResult> = {},
            ): GoalActionResult => ({
                ok: extra.ok ?? true,
                message,
                view,
                snapshot: view?.snapshot ?? null,
                structured: buildToolPayload(view),
                ...extra,
            });

            const shape: GoalEngineShape = {
                view: (input) =>
                    Effect.sync(() => {
                        const { loaded, view } = load(input);
                        return { view, issues: loaded.issues, entryId: loaded.entryId };
                    }),

                rehydrate: (input) =>
                    gate.withPermit(
                        Effect.gen(function* () {
                            const { branch, loaded, view } = load(input);
                            if (!loaded.snapshot || !view) {
                                return resultFor("No goal on this branch.", null);
                            }
                            if (input.reason === "fork" && loaded.snapshot.status !== "complete") {
                                const applied = yield* tryTransition(
                                    runTransition(
                                        loaded.snapshot,
                                        { type: "forked" },
                                        input,
                                        branch,
                                    ),
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                return resultFor(
                                    applied.failure
                                        ? `Goal was copied from another session; pausing it failed: ${applied.failure}`
                                        : "Goal was copied from another session and is paused here. Run /goal resume to continue it.",
                                    nextView ?? view,
                                );
                            }
                            return resultFor(
                                `Restored goal ${view.snapshot.goalId} (${view.snapshot.status}).`,
                                view,
                            );
                        }),
                    ),

                decideBoundary: (input) =>
                    gate.withPermit(
                        Effect.gen(function* () {
                            const { branch, loaded, view } = load(input);
                            if (!loaded.snapshot || !view) {
                                return {
                                    kind: "idle",
                                    reason: "no-goal",
                                    view: null,
                                } satisfies BoundaryDecision;
                            }
                            const policy = decideContinuation({
                                view,
                                facts: input.facts,
                                maxGoalTurns,
                                maxIdleTurns,
                                buildContinuationPrompt: continuationPrompt,
                                buildWrapUpPrompt: (current, reason) =>
                                    reason === "turn-cap"
                                        ? buildTurnCapWrapUpPrompt({
                                              objective: current.snapshot.objective,
                                              tokensUsed: current.metrics.usage.tokensUsed,
                                              budgetTokens: current.snapshot.budgetTokens,
                                              activeMs: current.snapshot.activeMs,
                                              maxGoalTurns,
                                          })
                                        : buildBudgetWrapUpPrompt({
                                              objective: current.snapshot.objective,
                                              tokensUsed: current.metrics.usage.tokensUsed,
                                              budgetTokens: current.snapshot.budgetTokens,
                                              activeMs: current.snapshot.activeMs,
                                          }),
                            });

                            if (policy.kind === "idle") {
                                return {
                                    kind: "idle",
                                    reason: policy.reason,
                                    view,
                                } satisfies BoundaryDecision;
                            }

                            if (policy.kind === "continue") {
                                return {
                                    kind: "continue",
                                    reason: policy.reason,
                                    goalId: view.snapshot.goalId,
                                    prompt: policy.prompt,
                                    directiveKind: "continuation",
                                    view,
                                } satisfies BoundaryDecision;
                            }

                            if (policy.kind === "budget-wrapup") {
                                // Flip to budgetLimited now, matching Codex, which marks the
                                // goal as soon as the budget is crossed and then allows one
                                // wrap-up turn. Pause/block requests stop taking effect here.
                                const exhausted =
                                    policy.reason === "budget"
                                        ? yield* tryTransition(
                                              runTransition(
                                                  loaded.snapshot,
                                                  { type: "budget-exhausted" },
                                                  input,
                                                  branch,
                                              ),
                                          )
                                        : null;
                                const wrapUpView =
                                    exhausted?.snapshot !== null && exhausted?.snapshot !== undefined
                                        ? deriveGoalView(exhausted.snapshot, input.readBranch())
                                        : view;
                                return {
                                    kind: "budget-wrapup",
                                    reason: policy.reason,
                                    goalId: wrapUpView.snapshot.goalId,
                                    prompt: policy.prompt,
                                    view: wrapUpView,
                                } satisfies BoundaryDecision;
                            }

                            const applied = yield* tryTransition(
                                runTransition(loaded.snapshot, policy.command, input, branch),
                            );
                            if (applied.failure) {
                                return {
                                    kind: "stopped",
                                    reason: policy.reason,
                                    notice: `${policy.notice} (state update failed: ${applied.failure})`,
                                    view,
                                } satisfies BoundaryDecision;
                            }
                            const nextView = applied.snapshot
                                ? deriveGoalView(applied.snapshot, input.readBranch())
                                : null;
                            return {
                                kind: "stopped",
                                reason: policy.reason,
                                notice: policy.notice,
                                view: nextView,
                            } satisfies BoundaryDecision;
                        }),
                    ),

                settle: (input) =>
                    gate.withPermit(
                        Effect.gen(function* () {
                            const { branch, loaded, view } = load(input);
                            if (!loaded.snapshot || !view) {
                                return { view: null, notice: null, events: [] };
                            }
                            let snapshot = loaded.snapshot;
                            let failure: string | null = null;

                            // Charge the run while the goal is still active, before an abort
                            // moves it to paused; a run started while paused is not charged.
                            if (input.activeMsDelta > 0 && snapshot.status === "active") {
                                const applied = yield* tryTransition(
                                    runTransition(
                                        snapshot,
                                        { type: "touch", activeMsDelta: input.activeMsDelta },
                                        input,
                                        branch,
                                    ),
                                );
                                failure = failure ?? applied.failure;
                                snapshot = applied.snapshot ?? snapshot;
                            }

                            if (input.aborted && snapshot.status === "active") {
                                const applied = yield* tryTransition(
                                    runTransition(
                                        snapshot,
                                        { type: "interrupted" },
                                        input,
                                        input.readBranch(),
                                    ),
                                );
                                failure = failure ?? applied.failure;
                                snapshot = applied.snapshot ?? snapshot;
                            }

                            const nextView = deriveGoalView(snapshot, input.readBranch());
                            let notice: string | null = null;
                            if (failure) {
                                notice = `Goal bookkeeping failed: ${failure}`;
                            } else if (input.aborted && snapshot.status === "paused") {
                                notice =
                                    "Goal paused after the interrupt. Run /goal resume to continue.";
                            }
                            return { view: nextView, notice };
                        }),
                    ),

                failSafe: (input) =>
                    gate.withPermit(
                        Effect.gen(function* () {
                            const { branch, loaded, view } = load(input);
                            if (!loaded.snapshot || !view) {
                                return resultFor("No goal on this branch.", null);
                            }
                            if (loaded.snapshot.status !== "active") {
                                return resultFor("Goal is not active; nothing to fail safe.", view);
                            }
                            const applied = yield* tryTransition(
                                runTransition(
                                    loaded.snapshot,
                                    {
                                        type: "pause",
                                        pauseReason: "internal-error",
                                        detail: clipped(input.detail),
                                    },
                                    input,
                                    branch,
                                ),
                            );
                            const nextView = applied.snapshot
                                ? deriveGoalView(applied.snapshot, input.readBranch())
                                : view;
                            return resultFor(
                                applied.failure
                                    ? `Goal could not be paused after an internal error: ${applied.failure}`
                                    : "Goal paused after an internal error. /goal resume retries.",
                                nextView,
                            );
                        }),
                    ),

                runCommand: (input) =>
                    gate.withPermit(
                        Effect.gen(function* () {
                            const { branch, loaded, view } = load(input);
                            const command = input.command;

                            if (command.type === "create") {
                                const oversized = budgetTooLarge(command.budgetTokens);
                                if (oversized) return yield* Effect.fail(oversized);
                                const applied = yield* runTransition(
                                    loaded.snapshot,
                                    {
                                        type: "create",
                                        objective: command.objective,
                                        budgetTokens: command.budgetTokens,
                                    },
                                    input,
                                    branch,
                                    { freshAnchor: true },
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                if (!nextView) {
                                    return yield* Effect.fail(
                                        new GoalRejectedError({
                                            message: "goal creation produced no snapshot",
                                            code: "persistence-failed",
                                        }),
                                    );
                                }
                                return resultFor(
                                    `Goal created: ${nextView.snapshot.goalId}`,
                                    nextView,
                                    {
                                        kickoffPrompt: buildKickoffPrompt({
                                            objective: nextView.snapshot.objective,
                                            tokensUsed: nextView.metrics.usage.tokensUsed,
                                            budgetTokens: nextView.snapshot.budgetTokens,
                                            remainingTokens: nextView.metrics.remainingTokens,
                                            goalTurns: nextView.metrics.goalTurns,
                                            status: nextView.snapshot.status,
                                            goalId: nextView.snapshot.goalId,
                                        }),
                                        directiveKind: "kickoff",
                                    },
                                );
                            }

                            if (command.type === "clear") {
                                if (!loaded.snapshot) {
                                    return resultFor("No goal to clear.", null);
                                }
                                yield* persistCleared(
                                    input.appendEntry,
                                    loaded.snapshot.goalId,
                                    input.now,
                                );
                                return resultFor("Goal cleared.", null);
                            }

                            if (!loaded.snapshot || !view) {
                                return yield* Effect.fail(
                                    new GoalNotFoundError({
                                        message:
                                            "this session has no goal; run /goal <objective> first",
                                    }),
                                );
                            }

                            if (command.type === "pause") {
                                const applied = yield* runTransition(
                                    loaded.snapshot,
                                    {
                                        type: "pause",
                                        pauseReason: "user",
                                        detail: command.detail,
                                    },
                                    input,
                                    branch,
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                return resultFor(
                                    nextView?.snapshot.status === "paused"
                                        ? "Goal paused."
                                        : `Pause has no effect while the goal status is ${nextView?.snapshot.status ?? "unknown"}; raise the budget and run /goal resume.`,
                                    nextView,
                                );
                            }

                            if (command.type === "resume") {
                                const applied = yield* runTransition(
                                    loaded.snapshot,
                                    { type: "resume" },
                                    input,
                                    branch,
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                if (!nextView) {
                                    return resultFor("Goal resumed.", null);
                                }
                                return resultFor("Goal resumed.", nextView, {
                                    kickoffPrompt: continuationPrompt(nextView),
                                    directiveKind: "continuation",
                                });
                            }

                            if (command.type === "edit") {
                                const applied = yield* runTransition(
                                    loaded.snapshot,
                                    { type: "edit", objective: command.objective },
                                    input,
                                    branch,
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                const prompt =
                                    nextView && nextView.snapshot.status === "active"
                                        ? buildObjectiveUpdatedPrompt({
                                              objective: nextView.snapshot.objective,
                                              tokensUsed: nextView.metrics.usage.tokensUsed,
                                              budgetTokens: nextView.snapshot.budgetTokens,
                                              remainingTokens: nextView.metrics.remainingTokens,
                                          })
                                        : undefined;
                                return resultFor("Goal objective updated.", nextView, {
                                    kickoffPrompt: prompt,
                                    directiveKind: "objective-updated",
                                });
                            }

                            const oversized = budgetTooLarge(command.budgetTokens);
                            if (oversized) return yield* Effect.fail(oversized);
                            const applied = yield* runTransition(
                                loaded.snapshot,
                                { type: "setBudget", budgetTokens: command.budgetTokens },
                                input,
                                branch,
                            );
                            let nextSnapshot = applied.snapshot ?? loaded.snapshot;
                            const tokensUsed = deriveUsage({
                                branch: input.readBranch(),
                                usageStartEntryId: nextSnapshot.usageStartEntryId,
                            }).tokensUsed;
                            const raised =
                                command.budgetTokens !== null &&
                                nextSnapshot.status === "budgetLimited" &&
                                command.budgetTokens > tokensUsed;
                            if (raised) {
                                const resumed = yield* runTransition(
                                    nextSnapshot,
                                    { type: "resume" },
                                    input,
                                    input.readBranch(),
                                );
                                nextSnapshot = resumed.snapshot ?? nextSnapshot;
                            }
                            const nextView = deriveGoalView(nextSnapshot, input.readBranch());
                            return resultFor("Goal budget updated.", nextView, {
                                kickoffPrompt: raised ? continuationPrompt(nextView) : undefined,
                                directiveKind: raised ? "continuation" : undefined,
                            });
                        }),
                    ),

                runTool: (input) =>
                    gate.withPermit(
                        Effect.gen(function* () {
                            const { branch, loaded, view: rawView } = load(input);
                            const view = withElapsedActiveMs(rawView, input.elapsedMs);
                            const call = input.call;

                            if (call.type === "get") {
                                return resultFor(
                                    view ? summarizeView(view) : "No goal is set for this session.",
                                    view,
                                );
                            }

                            if (call.type === "create") {
                                const oversized = budgetTooLarge(call.budgetTokens);
                                if (oversized) return yield* Effect.fail(oversized);
                                const applied = yield* runTransition(
                                    loaded.snapshot,
                                    {
                                        type: "create",
                                        objective: call.objective,
                                        budgetTokens: call.budgetTokens,
                                    },
                                    input,
                                    branch,
                                    { freshAnchor: true },
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                if (!nextView) {
                                    return yield* Effect.fail(
                                        new GoalRejectedError({
                                            message: "goal creation produced no snapshot",
                                            code: "persistence-failed",
                                        }),
                                    );
                                }
                                return resultFor(
                                    "Goal created with status active. Automatic continuation keeps it running.",
                                    nextView,
                                );
                            }

                            if (!loaded.snapshot || !view) {
                                return yield* Effect.fail(
                                    new GoalNotFoundError({
                                        message:
                                            "cannot update goal because this session has no goal",
                                    }),
                                );
                            }

                            if (call.status === "complete") {
                                if (view.metrics.currentTurnEvidence <= 0) {
                                    return yield* Effect.fail(
                                        new GoalRejectedError({
                                            message: buildCompletionRejectedMessage({
                                                evidenceCount: view.metrics.currentTurnEvidence,
                                            }),
                                            code: "completion-rejected",
                                        }),
                                    );
                                }
                                const elapsed = input.elapsedMs ?? 0;
                                const base =
                                    elapsed > 0
                                        ? (yield* runTransition(
                                              loaded.snapshot,
                                              { type: "touch", activeMsDelta: elapsed },
                                              input,
                                              branch,
                                          )).snapshot ?? loaded.snapshot
                                        : loaded.snapshot;
                                const applied = yield* runTransition(
                                    base,
                                    {
                                        type: "complete",
                                        evidenceCount: view.metrics.currentTurnEvidence,
                                    },
                                    input,
                                    input.readBranch(),
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                return resultFor(
                                    nextView
                                        ? buildCompletionReport(nextView)
                                        : "Goal marked complete.",
                                    nextView,
                                );
                            }

                            if (call.status === "blocked") {
                                if (view.metrics.auditedTurns < MIN_BLOCKED_AUDIT_TURNS) {
                                    return yield* Effect.fail(
                                        new GoalRejectedError({
                                            message: buildBlockedRejectedMessage({
                                                auditedTurns: view.metrics.auditedTurns,
                                                requiredTurns: MIN_BLOCKED_AUDIT_TURNS,
                                            }),
                                            code: "blocked-rejected",
                                        }),
                                    );
                                }
                                const reason = call.reason?.trim() ?? "";
                                const evidence = (call.evidence ?? []).filter(
                                    (item) => item.trim().length > 0,
                                );
                                if (reason.length === 0 || evidence.length === 0) {
                                    return yield* Effect.fail(
                                        new GoalRejectedError({
                                            message:
                                                "blocked requires a non-empty reason and at least one evidence item describing the recurring condition; keep working or report the blocker while the goal stays active.",
                                            code: "blocked-rejected",
                                        }),
                                    );
                                }
                                const applied = yield* runTransition(
                                    loaded.snapshot,
                                    {
                                        type: "block",
                                        reason,
                                        evidence,
                                        auditTurns: view.metrics.auditedTurns,
                                    },
                                    input,
                                    branch,
                                );
                                const nextView = applied.snapshot
                                    ? deriveGoalView(applied.snapshot, input.readBranch())
                                    : null;
                                return resultFor("Goal marked blocked.", nextView);
                            }

                            if (call.pauseAuthorized !== true) {
                                return yield* Effect.fail(
                                    new GoalRejectedError({
                                        message: buildPauseUnauthorizedMessage(),
                                        code: "pause-unauthorized",
                                    }),
                                );
                            }
                            const applied = yield* runTransition(
                                loaded.snapshot,
                                { type: "pause", pauseReason: "user", detail: call.reason },
                                input,
                                branch,
                            );
                            const nextView = applied.snapshot
                                ? deriveGoalView(applied.snapshot, input.readBranch())
                                : null;
                            return resultFor(
                                nextView?.snapshot.status === "paused"
                                    ? "Goal paused at the user's request."
                                    : `Pause has no effect while the goal status is ${nextView?.snapshot.status ?? "unknown"}. Report the returned status and stop goal work.`,
                                nextView,
                            );
                        }),
                    ),
            };

            return shape;
        }),
    );
}

/** Suggested `/goal` usage text shared by the command adapter. */
export const GOAL_USAGE = [
    "/goal <objective>        set a goal and start working toward it",
    "/goal                    show status",
    "/goal status             show status and metrics",
    "/goal pause              pause the current goal",
    "/goal resume             resume the current goal",
    "/goal clear              clear the current goal",
    "/goal edit               edit the objective",
    "/goal budget <tokens>    set a token budget (0 or off for unlimited)",
    "/goal history            show status history",
    "/goal debug              dump the snapshot and derived metrics",
].join("\n");
