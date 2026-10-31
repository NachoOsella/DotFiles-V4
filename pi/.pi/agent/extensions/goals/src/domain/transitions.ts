/**
 * Goal state machine.
 *
 * Pure transition function: no I/O, no clock, no Pi imports, and no direct
 * Effect runtime imports.
 * Every persisted change returns a new snapshot with a bumped revision; the
 * caller persists the outcome and surfaces the events.
 *
 * Transition table:
 *
 *   (no goal)   --create-->                active
 *   complete    --create-->                active (new goal id, counters reset)
 *   active      --pause-->                 paused
 *   active      --block (audit >= 3)-->    blocked
 *   active      --budget-exhausted-->      budgetLimited
 *   active|paused|blocked --usage-limited--> usageLimited
 *   paused|blocked|usageLimited|budgetLimited --resume--> active (limit needs a later budget edit)
 *   any but complete --complete (evidence)--> complete
 *   budgetLimited --pause|block-->         budgetLimited (unchanged, precedence)
 *   complete    --anything but create-->   InvalidTransition
 */
import {
    GOAL_SNAPSHOT_VERSION,
    MAX_OBJECTIVE_CHARS,
    MIN_BLOCKED_AUDIT_TURNS,
    type GoalErrorCode,
    type GoalHistoryEntry,
    type GoalPause,
    type GoalSnapshot,
    type GoalStatus,
    type PauseReason,
} from "./goal.ts";
import {
    GoalConflictError,
    GoalNotFoundError,
    GoalRejectedError,
    GoalValidationError,
    InvalidTransitionError,
    type GoalError,
} from "./errors.ts";
import type { GoalEvent } from "./events.ts";

/** Newest history entries kept in a snapshot. */
const MAX_HISTORY_ENTRIES = 40;

export interface TransitionContext {
    readonly now: number;
    readonly goalId: string;
    readonly sessionId: string;
    readonly usageStartEntryId: string | null;
    /** Derived usage for this goal; when present, resume checks it against the budget. */
    readonly tokensUsed?: number;
    readonly goalTurns: number;
}

export type TransitionCommand =
    | { type: "create"; objective: string; budgetTokens: number | null }
    | { type: "pause"; pauseReason: PauseReason; detail?: string }
    | { type: "resume" }
    | { type: "edit"; objective: string }
    | { type: "setBudget"; budgetTokens: number | null }
    | { type: "complete"; evidenceCount: number }
    | { type: "block"; reason: string; evidence: readonly string[]; auditTurns: number }
    | { type: "budget-exhausted" }
    | { type: "usage-limited"; detail: string }
    | { type: "provider-error"; detail: string }
    | { type: "interrupted" }
    | { type: "no-progress"; idleTurns: number }
    | { type: "forked" }
    | { type: "touch"; activeMsDelta: number };

export interface TransitionOutcome {
    readonly snapshot: GoalSnapshot | null;
    readonly events: readonly GoalEvent[];
}

export type TransitionResult =
    | { ok: true; outcome: TransitionOutcome }
    | { ok: false; error: GoalError };

export function transition(
    current: GoalSnapshot | null,
    command: TransitionCommand,
    context: TransitionContext,
): TransitionResult {
    const now = context.now;

    switch (command.type) {
        case "create": {
            if (current !== null && current.status !== "complete") {
                return failure(
                    new GoalConflictError({
                        message:
                            "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
                    }),
                );
            }

            const objectiveError = validateObjective(command.objective);
            if (objectiveError !== null) return failure(objectiveError);
            const budgetError = validateBudgetTokens(command.budgetTokens);
            if (budgetError !== null) return failure(budgetError);

            const objective = command.objective.trim();
            const snapshot: GoalSnapshot = {
                version: GOAL_SNAPSHOT_VERSION,
                goalId: context.goalId,
                sessionId: context.sessionId,
                revision: 1,
                status: "active",
                objective,
                budgetTokens: command.budgetTokens,
                usageStartEntryId: context.usageStartEntryId,
                createdAt: now,
                updatedAt: now,
                statusChangedAt: now,
                activeMs: 0,
                turnBaseline: 0,
                pause: null,
                block: null,
                completion: { attempts: 0, lastRequestedAt: null, verifiedAt: null },
                history: [{ at: now, from: null, to: "active", reason: "created" }],
            };
            return success(snapshot, [
                { type: "goal.created", goalId: snapshot.goalId, objective, at: now },
            ]);
        }

        case "pause": {
            if (current === null) return missingGoal("pause");
            if (current.status === "budgetLimited") return unchanged(current);
            if (current.status !== "active") {
                return invalid(
                    current.status,
                    "paused",
                    `cannot pause a goal with status ${current.status}`,
                );
            }

            const snapshot = commit(
                current,
                now,
                {
                    status: "paused",
                    pause: pauseRecord(command.pauseReason, now, command.detail),
                },
                historyEntry("active", "paused", now, command.pauseReason, command.detail),
            );
            return success(snapshot, [
                statusEvent(snapshot.goalId, "active", "paused", command.pauseReason, now),
            ]);
        }

        case "resume": {
            if (current === null) return missingGoal("resume");
            if (current.status === "active") {
                return invalid("active", "active", "cannot resume a goal that is already active");
            }
            if (current.status === "complete") {
                return invalid("complete", "active", "cannot resume a complete goal");
            }
            const exhausted =
                context.tokensUsed !== undefined && current.budgetTokens !== null
                    ? context.tokensUsed >= current.budgetTokens
                    : current.status === "budgetLimited" && !budgetChangedSinceLimit(current.history);
            if (exhausted) {
                return rejected(
                    "budget-exceeded",
                    "cannot resume a goal whose token budget is exhausted; raise the budget first",
                );
            }

            const snapshot = commit(
                current,
                now,
                { status: "active", pause: null, block: null, turnBaseline: context.goalTurns },
                historyEntry(current.status, "active", now, "resumed"),
            );
            return success(snapshot, [
                statusEvent(snapshot.goalId, current.status, "active", "resumed", now),
            ]);
        }

        case "edit": {
            if (current === null) return missingGoal("edit");
            if (current.status === "complete") {
                return invalid("complete", "complete", "cannot edit the objective of a complete goal");
            }

            const objectiveError = validateObjective(command.objective);
            if (objectiveError !== null) return failure(objectiveError);

            const snapshot = commit(
                current,
                now,
                { objective: command.objective.trim() },
                historyEntry(current.status, current.status, now, "objective-edited"),
            );
            return success(snapshot);
        }

        case "setBudget": {
            if (current === null) return missingGoal("setBudget");
            if (current.status === "complete") {
                return invalid("complete", "complete", "cannot change the budget of a complete goal");
            }

            const budgetError = validateBudgetTokens(command.budgetTokens);
            if (budgetError !== null) return failure(budgetError);

            const snapshot = commit(
                current,
                now,
                { budgetTokens: command.budgetTokens },
                historyEntry(current.status, current.status, now, "budget-edited"),
            );
            return success(snapshot);
        }

        case "complete": {
            if (current === null) return missingGoal("complete");
            if (current.status === "complete") {
                return invalid("complete", "complete", "cannot complete a goal that is already complete");
            }
            if (command.evidenceCount <= 0) {
                return rejected(
                    "completion-rejected",
                    "cannot complete the goal: completion needs current-state evidence from this goal turn",
                );
            }

            const snapshot = commit(
                current,
                now,
                {
                    status: "complete",
                    pause: null,
                    block: null,
                    completion: {
                        attempts: current.completion.attempts + 1,
                        lastRequestedAt: now,
                        verifiedAt: now,
                    },
                },
                historyEntry(current.status, "complete", now, "completed"),
            );
            return success(snapshot, [
                statusEvent(snapshot.goalId, current.status, "complete", "completed", now),
            ]);
        }

        case "block": {
            if (current === null) return missingGoal("block");
            if (current.status === "complete") {
                return invalid("complete", "blocked", "cannot block a complete goal");
            }
            if (current.status === "budgetLimited") return unchanged(current);
            if (command.auditTurns < MIN_BLOCKED_AUDIT_TURNS) {
                return rejected(
                    "blocked-rejected",
                    `cannot mark the goal blocked after ${command.auditTurns} audited goal turns; the same blocker must recur for at least ${MIN_BLOCKED_AUDIT_TURNS} consecutive goal turns`,
                );
            }

            const reason = command.reason.trim();
            if (reason.length === 0) {
                return rejected("blocked-rejected", "cannot mark the goal blocked without a reason");
            }

            const snapshot = commit(
                current,
                now,
                {
                    status: "blocked",
                    pause: null,
                    block: { reason, evidence: [...command.evidence], at: now },
                },
                historyEntry(current.status, "blocked", now, "blocked"),
            );
            const events =
                current.status === "blocked"
                    ? []
                    : [statusEvent(snapshot.goalId, current.status, "blocked", "blocked", now)];
            return success(snapshot, events);
        }

        case "budget-exhausted": {
            if (current === null) return missingGoal("budget-exhausted");
            if (current.status === "budgetLimited") return unchanged(current);
            if (current.status !== "active") {
                return invalid(
                    current.status,
                    "budgetLimited",
                    `cannot mark a ${current.status} goal as budget-limited`,
                );
            }

            const snapshot = commit(
                current,
                now,
                { status: "budgetLimited" },
                historyEntry("active", "budgetLimited", now, "budget-exhausted"),
            );
            return success(snapshot, [
                statusEvent(snapshot.goalId, "active", "budgetLimited", "budget-exhausted", now),
            ]);
        }

        case "usage-limited": {
            if (current === null) return missingGoal("usage-limited");
            if (current.status === "budgetLimited" || current.status === "usageLimited") {
                return unchanged(current);
            }
            if (current.status === "complete") {
                return invalid("complete", "usageLimited", "cannot usage-limit a complete goal");
            }

            const snapshot = commit(
                current,
                now,
                { status: "usageLimited", pause: null, block: null },
                historyEntry(
                    current.status,
                    "usageLimited",
                    now,
                    "usage-limited",
                    command.detail,
                ),
            );
            return success(snapshot, [
                statusEvent(
                    snapshot.goalId,
                    current.status,
                    "usageLimited",
                    "usage-limited",
                    now,
                ),
            ]);
        }

        case "provider-error": {
            if (current === null) return missingGoal("provider-error");
            return pauseFromActive(current, context, "provider-error", command.detail);
        }

        case "interrupted": {
            if (current === null) return missingGoal("interrupted");
            return pauseFromActive(current, context, "interrupted");
        }

        case "no-progress": {
            if (current === null) return missingGoal("no-progress");
            return pauseFromActive(
                current,
                context,
                "no-progress",
                `no successful tool results for ${command.idleTurns} goal turns`,
            );
        }

        case "forked": {
            if (current === null) return missingGoal("forked");
            if (current.status === "complete") {
                return invalid("complete", "paused", "cannot fork a complete goal");
            }
            if (current.status === "budgetLimited") {
                // Keep the budget fact in the fork: only a budget edit can resume it.
                return success(
                    commit(
                        current,
                        now,
                        { sessionId: context.sessionId },
                        historyEntry(current.status, current.status, now, "forked"),
                    ),
                );
            }

            const snapshot = commit(
                current,
                now,
                {
                    status: "paused",
                    pause: pauseRecord("forked", now),
                    sessionId: context.sessionId,
                },
                historyEntry(current.status, "paused", now, "forked"),
            );
            const events =
                current.status === "paused"
                    ? []
                    : [statusEvent(snapshot.goalId, current.status, "paused", "forked", now)];
            return success(snapshot, events);
        }

        case "touch": {
            if (current === null) return missingGoal("touch");
            if (current.status === "complete") {
                return invalid("complete", "complete", "cannot record active time for a complete goal");
            }

            const delta = Number.isFinite(command.activeMsDelta)
                ? Math.max(0, command.activeMsDelta)
                : 0;
            return success(commit(current, now, { activeMs: current.activeMs + delta }, null));
        }
    }

    // Only reachable from untyped callers; keeps the function total without throwing.
    return failure(
        new InvalidTransitionError({
            message: "unsupported goal transition command",
            from: current?.status ?? null,
            to: current?.status ?? "active",
        }),
    );
}

/** Validation shared by `create` and `edit`; returns the typed error or null. */
export function validateObjective(objective: string): GoalError | null {
    const trimmed = objective.trim();
    if (trimmed.length === 0) {
        return new GoalValidationError({
            message: "goal objective must not be empty",
            field: "objective",
        });
    }
    // Codex counts Unicode code points, not UTF-16 code units.
    if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
        return new GoalValidationError({
            message: `goal objective must be at most ${MAX_OBJECTIVE_CHARS} characters`,
            field: "objective",
        });
    }
    return null;
}

/** Validation shared by `create` and `setBudget`; returns the typed error or null. */
export function validateBudgetTokens(budgetTokens: number | null): GoalError | null {
    if (budgetTokens === null) return null;
    if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
        return new GoalValidationError({
            message: "goal budgets must be positive integers when provided",
            field: "budget",
        });
    }
    return null;
}

type SnapshotPatch = Partial<
    Pick<
        GoalSnapshot,
        | "status"
        | "objective"
        | "budgetTokens"
        | "usageStartEntryId"
        | "activeMs"
        | "turnBaseline"
        | "pause"
        | "block"
        | "completion"
        | "sessionId"
    >
>;

/**
 * Apply one persisted change. The input snapshot is never mutated: the patch,
 * history, and pause/block records are fresh objects.
 */
function commit(
    current: GoalSnapshot,
    now: number,
    patch: SnapshotPatch,
    entry: GoalHistoryEntry | null,
): GoalSnapshot {
    const status = patch.status ?? current.status;
    return {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: now,
        statusChangedAt: status === current.status ? current.statusChangedAt : now,
        history:
            entry === null
                ? current.history
                : [...current.history, entry].slice(-MAX_HISTORY_ENTRIES),
    };
}

function pauseFromActive(
    current: GoalSnapshot,
    context: TransitionContext,
    reason: PauseReason,
    detail?: string,
): TransitionResult {
    if (current.status === "complete") {
        return invalid("complete", "paused", `cannot pause a complete goal (${reason})`);
    }
    // An existing pause reason wins over a repeated system signal.
    if (current.status !== "active") return unchanged(current);

    const now = context.now;
    const snapshot = commit(
        current,
        now,
        { status: "paused", pause: pauseRecord(reason, now, detail) },
        historyEntry("active", "paused", now, reason, detail),
    );
    return success(snapshot, [statusEvent(snapshot.goalId, "active", "paused", reason, now)]);
}

function historyEntry(
    from: GoalStatus | null,
    to: GoalStatus,
    at: number,
    reason: string,
    detail?: string,
): GoalHistoryEntry {
    return detail === undefined ? { at, from, to, reason } : { at, from, to, reason, detail };
}

function pauseRecord(reason: PauseReason, at: number, detail?: string): GoalPause {
    return detail === undefined ? { reason, at } : { reason, detail, at };
}

/**
 * The snapshot has no token count, so history is the only evidence that the
 * budget was changed after the goal hit the limit. A later edit is the user's
 * authorization to resume; without one, resume stays rejected.
 */
function budgetChangedSinceLimit(history: readonly GoalHistoryEntry[]): boolean {
    let editIndex = -1;
    let limitIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const reason = history[index]?.reason;
        if (editIndex === -1 && reason === "budget-edited") editIndex = index;
        if (limitIndex === -1 && reason === "budget-exhausted") limitIndex = index;
        if (editIndex !== -1 && limitIndex !== -1) break;
    }
    return editIndex !== -1 && (limitIndex === -1 || editIndex > limitIndex);
}

function statusEvent(
    goalId: string,
    from: GoalStatus,
    to: GoalStatus,
    reason: string,
    at: number,
): GoalEvent {
    return { type: "goal.status-changed", goalId, from, to, reason, at };
}

function success(
    snapshot: GoalSnapshot | null,
    events: readonly GoalEvent[] = [],
): TransitionResult {
    return { ok: true, outcome: { snapshot, events } };
}

function unchanged(snapshot: GoalSnapshot): TransitionResult {
    return success(snapshot);
}

function failure(error: GoalError): TransitionResult {
    return { ok: false, error };
}

function invalid(
    current: GoalStatus | null,
    to: GoalStatus,
    message: string,
): TransitionResult {
    return failure(new InvalidTransitionError({ message, from: current, to }));
}

function missingGoal(command: TransitionCommand["type"]): TransitionResult {
    return failure(
        new GoalNotFoundError({
            message: `cannot apply ${command} because this thread has no goal`,
        }),
    );
}

function rejected(code: GoalErrorCode, message: string): TransitionResult {
    return failure(new GoalRejectedError({ message, code }));
}
