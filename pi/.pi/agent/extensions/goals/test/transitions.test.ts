import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { GoalError } from "../src/domain/errors.ts";
import {
    GOAL_SNAPSHOT_VERSION,
    MAX_OBJECTIVE_CHARS,
    type GoalErrorCode,
    type GoalSnapshot,
    type GoalStatus,
} from "../src/domain/goal.ts";
import {
    transition,
    validateBudgetTokens,
    validateObjective,
    type TransitionCommand,
    type TransitionContext,
    type TransitionOutcome,
    type TransitionResult,
} from "../src/domain/transitions.ts";

const NOW = 1_000;

const CONTEXT: TransitionContext = {
    now: NOW,
    goalId: "goal-new",
    sessionId: "session-1",
    usageStartEntryId: "entry-start",
    goalTurns: 6,
};

function withNow(now: number): TransitionContext {
    return { ...CONTEXT, now };
}

function makeSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    return {
        version: GOAL_SNAPSHOT_VERSION,
        goalId: "goal-1",
        sessionId: "session-1",
        revision: 3,
        status: "active",
        objective: "Refactor the parser",
        budgetTokens: null,
        usageStartEntryId: "entry-old",
        createdAt: 100,
        updatedAt: 200,
        statusChangedAt: 200,
        activeMs: 500,
        turnBaseline: 1,
        pause: null,
        block: null,
        completion: { attempts: 0, lastRequestedAt: null, verifiedAt: null },
        history: [{ at: 100, from: null, to: "active", reason: "created" }],
        ...overrides,
    };
}

function expectOk(result: TransitionResult): TransitionOutcome {
    if (!result.ok) {
        assert.fail(`expected success, got ${result.error._tag}: ${result.error.message}`);
    }
    return result.outcome;
}

function expectSnapshot(result: TransitionResult): GoalSnapshot {
    const outcome = expectOk(result);
    if (outcome.snapshot === null) assert.fail("expected a snapshot");
    return outcome.snapshot;
}

function expectError(result: TransitionResult): GoalError {
    if (result.ok) assert.fail("expected failure, got success");
    return result.error;
}

function expectRejected(result: TransitionResult, code: GoalErrorCode): GoalError {
    const error = expectError(result);
    if (error._tag !== "GoalRejectedError") {
        assert.fail(`expected GoalRejectedError, got ${error._tag}`);
    }
    assert.equal(error.code, code);
    return error;
}

function expectValidation(result: TransitionResult): GoalError {
    const error = expectError(result);
    assert.equal(error._tag, "GoalValidationError");
    return error;
}

describe("create", () => {
    test("creates a fresh active goal and a created event", () => {
        const outcome = expectOk(
            transition(
                null,
                { type: "create", objective: "  Ship the parser  ", budgetTokens: 100 },
                CONTEXT,
            ),
        );
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);

        assert.equal(snapshot.version, GOAL_SNAPSHOT_VERSION);
        assert.equal(snapshot.goalId, "goal-new");
        assert.equal(snapshot.sessionId, "session-1");
        assert.equal(snapshot.revision, 1);
        assert.equal(snapshot.status, "active");
        assert.equal(snapshot.objective, "Ship the parser");
        assert.equal(snapshot.budgetTokens, 100);
        assert.equal(snapshot.usageStartEntryId, "entry-start");
        assert.equal(snapshot.createdAt, NOW);
        assert.equal(snapshot.updatedAt, NOW);
        assert.equal(snapshot.statusChangedAt, NOW);
        assert.equal(snapshot.activeMs, 0);
        assert.equal(snapshot.turnBaseline, 0);
        assert.equal(snapshot.pause, null);
        assert.equal(snapshot.block, null);
        assert.deepEqual(snapshot.completion, {
            attempts: 0,
            lastRequestedAt: null,
            verifiedAt: null,
        });
        assert.deepEqual(snapshot.history, [
            { at: NOW, from: null, to: "active", reason: "created" },
        ]);
        assert.deepEqual(outcome.events, [
            { type: "goal.created", goalId: "goal-new", objective: "Ship the parser", at: NOW },
        ]);
    });

    test("replaces a complete goal with a new id and zeroed counters", () => {
        const complete = makeSnapshot({
            status: "complete",
            goalId: "goal-old",
            revision: 9,
            activeMs: 9_999,
            turnBaseline: 4,
            pause: { reason: "user", at: 50 },
            block: { reason: "old blocker", evidence: ["x"], at: 60 },
            completion: { attempts: 2, lastRequestedAt: 70, verifiedAt: 80 },
            history: [
                { at: 100, from: null, to: "active", reason: "created" },
                { at: 200, from: "active", to: "complete", reason: "completed" },
            ],
        });

        const snapshot = expectSnapshot(
            transition(
                complete,
                { type: "create", objective: "Second attempt", budgetTokens: null },
                CONTEXT,
            ),
        );

        assert.equal(snapshot.goalId, "goal-new");
        assert.equal(snapshot.revision, 1);
        assert.equal(snapshot.status, "active");
        assert.equal(snapshot.objective, "Second attempt");
        assert.equal(snapshot.budgetTokens, null);
        assert.equal(snapshot.usageStartEntryId, "entry-start");
        assert.equal(snapshot.createdAt, NOW);
        assert.equal(snapshot.updatedAt, NOW);
        assert.equal(snapshot.statusChangedAt, NOW);
        assert.equal(snapshot.activeMs, 0);
        assert.equal(snapshot.turnBaseline, 0);
        assert.equal(snapshot.pause, null);
        assert.equal(snapshot.block, null);
        assert.deepEqual(snapshot.completion, {
            attempts: 0,
            lastRequestedAt: null,
            verifiedAt: null,
        });
        assert.deepEqual(snapshot.history, [
            { at: NOW, from: null, to: "active", reason: "created" },
        ]);
    });

    test("rejects creation while any unfinished goal exists", () => {
        const unfinished: readonly GoalStatus[] = [
            "active",
            "paused",
            "blocked",
            "usageLimited",
            "budgetLimited",
        ];
        for (const status of unfinished) {
            const result = transition(
                makeSnapshot({ status }),
                { type: "create", objective: "Another goal", budgetTokens: null },
                CONTEXT,
            );
            const error = expectError(result);
            assert.equal(error._tag, "GoalConflictError", `status ${status}`);
            assert.match(error.message, /unfinished goal/);
        }
    });

    test("rejects empty and over-long objectives", () => {
        const empty = expectValidation(
            transition(
                null,
                { type: "create", objective: "   ", budgetTokens: null },
                CONTEXT,
            ),
        );
        assert.equal(empty._tag === "GoalValidationError" ? empty.field : null, "objective");

        const tooLong = expectValidation(
            transition(
                null,
                {
                    type: "create",
                    objective: "a".repeat(MAX_OBJECTIVE_CHARS + 1),
                    budgetTokens: null,
                },
                CONTEXT,
            ),
        );
        assert.equal(tooLong._tag === "GoalValidationError" ? tooLong.field : null, "objective");
    });

    test("accepts an objective at the character limit", () => {
        const snapshot = expectSnapshot(
            transition(
                null,
                {
                    type: "create",
                    objective: "a".repeat(MAX_OBJECTIVE_CHARS),
                    budgetTokens: null,
                },
                CONTEXT,
            ),
        );
        assert.equal(snapshot.objective.length, MAX_OBJECTIVE_CHARS);
    });

    test("rejects zero, negative, and non-integer budgets", () => {
        for (const budgetTokens of [0, -10, 1.5, Number.NaN]) {
            const result = transition(
                null,
                { type: "create", objective: "Budgeted goal", budgetTokens },
                CONTEXT,
            );
            const error = expectValidation(result);
            assert.equal(error._tag === "GoalValidationError" ? error.field : null, "budget");
        }
    });
});

describe("pause", () => {
    test("pauses an active goal with a pause record and history", () => {
        const outcome = expectOk(
            transition(
                makeSnapshot(),
                { type: "pause", pauseReason: "user", detail: "user asked" },
                CONTEXT,
            ),
        );
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);

        assert.equal(snapshot.status, "paused");
        assert.equal(snapshot.revision, 4);
        assert.equal(snapshot.updatedAt, NOW);
        assert.equal(snapshot.statusChangedAt, NOW);
        assert.deepEqual(snapshot.pause, { reason: "user", detail: "user asked", at: NOW });
        assert.deepEqual(snapshot.history.at(-1), {
            at: NOW,
            from: "active",
            to: "paused",
            reason: "user",
            detail: "user asked",
        });
        assert.deepEqual(outcome.events, [
            {
                type: "goal.status-changed",
                goalId: "goal-1",
                from: "active",
                to: "paused",
                reason: "user",
                at: NOW,
            },
        ]);
    });

    test("is a no-op on a budget-limited goal (budget precedence)", () => {
        const current = makeSnapshot({ status: "budgetLimited" });
        const outcome = expectOk(
            transition(current, { type: "pause", pauseReason: "user" }, CONTEXT),
        );
        assert.strictEqual(outcome.snapshot, current);
        assert.equal(outcome.events.length, 0);
    });

    test("rejects pause from every other status and from no goal", () => {
        const invalidSources: readonly GoalStatus[] = ["paused", "blocked", "usageLimited", "complete"];
        for (const status of invalidSources) {
            const error = expectError(
                transition(
                    makeSnapshot({ status }),
                    { type: "pause", pauseReason: "user" },
                    CONTEXT,
                ),
            );
            assert.equal(error._tag, "InvalidTransitionError", `status ${status}`);
        }

        const noGoal = expectError(
            transition(null, { type: "pause", pauseReason: "user" }, CONTEXT),
        );
        assert.equal(noGoal._tag, "GoalNotFoundError");
    });
});

describe("resume", () => {
    test("resumes paused, blocked, and usage-limited goals", () => {
        const sources: readonly GoalStatus[] = ["paused", "blocked", "usageLimited"];
        for (const status of sources) {
            const current = makeSnapshot({
                status,
                pause: status === "paused" ? { reason: "user", at: 50 } : null,
                block: status === "blocked" ? { reason: "stuck", evidence: [], at: 60 } : null,
            });
            const outcome = expectOk(transition(current, { type: "resume" }, CONTEXT));
            const snapshot = outcome.snapshot;
            assert.ok(snapshot !== null);

            assert.equal(snapshot.status, "active", `status ${status}`);
            assert.equal(snapshot.pause, null);
            assert.equal(snapshot.block, null);
            assert.equal(snapshot.revision, current.revision + 1);
            assert.equal(snapshot.statusChangedAt, NOW);
            assert.deepEqual(snapshot.history.at(-1), {
                at: NOW,
                from: status,
                to: "active",
                reason: "resumed",
            });
            assert.equal(outcome.events.length, 1);
        }
    });

    test("resets turnBaseline to the current goal turn (fresh blocked audit)", () => {
        const snapshot = expectSnapshot(
            transition(makeSnapshot({ status: "paused", turnBaseline: 1 }), { type: "resume" }, CONTEXT),
        );
        assert.equal(snapshot.turnBaseline, CONTEXT.goalTurns);
    });

    test("rejects resume of a budget-limited goal whose budget was not changed", () => {
        const error = expectRejected(
            transition(makeSnapshot({ status: "budgetLimited" }), { type: "resume" }, CONTEXT),
            "budget-exceeded",
        );
        assert.match(error.message, /budget/);
    });

    test("allows resume after a budget edit made since the limit", () => {
        const limited = makeSnapshot({
            status: "budgetLimited",
            budgetTokens: 100,
            history: [
                { at: 100, from: null, to: "active", reason: "created" },
                { at: 200, from: "active", to: "budgetLimited", reason: "budget-exhausted" },
            ],
        });
        const raised = expectSnapshot(
            transition(limited, { type: "setBudget", budgetTokens: 500 }, CONTEXT),
        );
        assert.equal(raised.status, "budgetLimited");

        const resumed = expectSnapshot(transition(raised, { type: "resume" }, CONTEXT));
        assert.equal(resumed.status, "active");
    });

    test("rejects resume when the last budget edit predates the limit", () => {
        const limited = makeSnapshot({
            status: "budgetLimited",
            history: [
                { at: 100, from: null, to: "active", reason: "created" },
                { at: 150, from: "active", to: "active", reason: "budget-edited" },
                { at: 200, from: "active", to: "budgetLimited", reason: "budget-exhausted" },
            ],
        });
        expectRejected(transition(limited, { type: "resume" }, CONTEXT), "budget-exceeded");
    });

    test("rejects resume when active or complete", () => {
        const active = expectError(
            transition(makeSnapshot({ status: "active" }), { type: "resume" }, CONTEXT),
        );
        assert.equal(active._tag, "InvalidTransitionError");
        assert.match(active.message, /already active/);

        const complete = expectError(
            transition(makeSnapshot({ status: "complete" }), { type: "resume" }, CONTEXT),
        );
        assert.equal(complete._tag, "InvalidTransitionError");
    });

    test("rejects resume with no goal", () => {
        assert.equal(expectError(transition(null, { type: "resume" }, CONTEXT))._tag, "GoalNotFoundError");
    });
});

describe("edit and setBudget", () => {
    test("edits the objective, keeps the status, and appends history", () => {
        const current = makeSnapshot({ status: "paused", objective: "Old", pause: { reason: "user", at: 50 } });
        const outcome = expectOk(
            transition(current, { type: "edit", objective: "  New objective  " }, CONTEXT),
        );
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);

        assert.equal(snapshot.objective, "New objective");
        assert.equal(snapshot.status, "paused");
        assert.equal(snapshot.statusChangedAt, 200);
        assert.equal(snapshot.revision, 4);
        assert.equal(snapshot.updatedAt, NOW);
        assert.deepEqual(snapshot.pause, { reason: "user", at: 50 });
        assert.deepEqual(snapshot.history.at(-1), {
            at: NOW,
            from: "paused",
            to: "paused",
            reason: "objective-edited",
        });
        assert.equal(outcome.events.length, 0);
    });

    test("rejects edit of a complete goal, with no goal, and invalid objectives", () => {
        assert.equal(
            expectError(
                transition(makeSnapshot({ status: "complete" }), { type: "edit", objective: "New" }, CONTEXT),
            )._tag,
            "InvalidTransitionError",
        );
        assert.equal(
            expectError(transition(null, { type: "edit", objective: "New" }, CONTEXT))._tag,
            "GoalNotFoundError",
        );
        assert.equal(
            expectValidation(
                transition(makeSnapshot(), { type: "edit", objective: "  " }, CONTEXT),
            )._tag,
            "GoalValidationError",
        );
    });

    test("sets and clears the budget without changing status", () => {
        const withBudget = expectSnapshot(
            transition(makeSnapshot({ status: "paused" }), { type: "setBudget", budgetTokens: 250 }, CONTEXT),
        );
        assert.equal(withBudget.budgetTokens, 250);
        assert.equal(withBudget.status, "paused");
        assert.equal(withBudget.revision, 4);
        assert.equal(withBudget.statusChangedAt, 200);
        assert.deepEqual(withBudget.history.at(-1), {
            at: NOW,
            from: "paused",
            to: "paused",
            reason: "budget-edited",
        });

        const cleared = expectSnapshot(
            transition(withBudget, { type: "setBudget", budgetTokens: null }, CONTEXT),
        );
        assert.equal(cleared.budgetTokens, null);
        assert.equal(cleared.status, "paused");
    });

    test("rejects setBudget on a complete goal, with no goal, and invalid budgets", () => {
        assert.equal(
            expectError(
                transition(makeSnapshot({ status: "complete" }), { type: "setBudget", budgetTokens: 10 }, CONTEXT),
            )._tag,
            "InvalidTransitionError",
        );
        assert.equal(
            expectError(transition(null, { type: "setBudget", budgetTokens: 10 }, CONTEXT))._tag,
            "GoalNotFoundError",
        );
        for (const budgetTokens of [0, -1, 2.5]) {
            assert.equal(
                expectValidation(
                    transition(makeSnapshot(), { type: "setBudget", budgetTokens }, CONTEXT),
                )._tag,
                "GoalValidationError",
            );
        }
    });
});

describe("complete", () => {
    test("rejects completion without current-turn evidence", () => {
        for (const evidenceCount of [0, -1]) {
            const error = expectRejected(
                transition(makeSnapshot(), { type: "complete", evidenceCount }, CONTEXT),
                "completion-rejected",
            );
            assert.match(error.message, /current-state evidence/);
            assert.match(error.message, /goal turn/);
        }
    });

    test("completes with evidence and records the verification time", () => {
        const current = makeSnapshot({
            status: "paused",
            pause: { reason: "user", at: 50 },
            completion: { attempts: 2, lastRequestedAt: 90, verifiedAt: null },
        });
        const outcome = expectOk(transition(current, { type: "complete", evidenceCount: 2 }, CONTEXT));
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);

        assert.equal(snapshot.status, "complete");
        assert.equal(snapshot.pause, null);
        assert.equal(snapshot.block, null);
        assert.deepEqual(snapshot.completion, {
            attempts: 3,
            lastRequestedAt: NOW,
            verifiedAt: NOW,
        });
        assert.equal(snapshot.statusChangedAt, NOW);
        assert.deepEqual(snapshot.history.at(-1), {
            at: NOW,
            from: "paused",
            to: "complete",
            reason: "completed",
        });
        assert.deepEqual(outcome.events, [
            {
                type: "goal.status-changed",
                goalId: "goal-1",
                from: "paused",
                to: "complete",
                reason: "completed",
                at: NOW,
            },
        ]);
    });

    test("rejects completion of an already complete goal or with no goal", () => {
        assert.equal(
            expectError(
                transition(makeSnapshot({ status: "complete" }), { type: "complete", evidenceCount: 1 }, CONTEXT),
            )._tag,
            "InvalidTransitionError",
        );
        assert.equal(
            expectError(transition(null, { type: "complete", evidenceCount: 1 }, CONTEXT))._tag,
            "GoalNotFoundError",
        );
    });
});

describe("block", () => {
    test("rejects a blocked audit shorter than three turns", () => {
        const error = expectRejected(
            transition(
                makeSnapshot(),
                { type: "block", reason: "stuck", evidence: ["log"], auditTurns: 2 },
                CONTEXT,
            ),
            "blocked-rejected",
        );
        assert.match(error.message, /3 consecutive goal turns/);
    });

    test("blocks at three audited turns with evidence", () => {
        const evidence = ["test fails", "missing upstream API"];
        const outcome = expectOk(
            transition(
                makeSnapshot({ status: "paused", pause: { reason: "user", at: 50 } }),
                { type: "block", reason: "  upstream API is unavailable  ", evidence, auditTurns: 3 },
                CONTEXT,
            ),
        );
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);

        assert.equal(snapshot.status, "blocked");
        assert.equal(snapshot.pause, null);
        assert.deepEqual(snapshot.block, {
            reason: "upstream API is unavailable",
            evidence,
            at: NOW,
        });
        assert.equal(snapshot.statusChangedAt, NOW);
        assert.deepEqual(snapshot.history.at(-1), {
            at: NOW,
            from: "paused",
            to: "blocked",
            reason: "blocked",
        });
        assert.equal(outcome.events.length, 1);
    });

    test("rejects block without a reason", () => {
        const error = expectRejected(
            transition(
                makeSnapshot(),
                { type: "block", reason: "   ", evidence: [], auditTurns: 3 },
                CONTEXT,
            ),
            "blocked-rejected",
        );
        assert.match(error.message, /reason/);
    });

    test("is a no-op on a budget-limited goal", () => {
        const current = makeSnapshot({ status: "budgetLimited" });
        const outcome = expectOk(
            transition(
                current,
                { type: "block", reason: "stuck", evidence: [], auditTurns: 0 },
                CONTEXT,
            ),
        );
        assert.strictEqual(outcome.snapshot, current);
        assert.equal(outcome.events.length, 0);
    });

    test("rejects block on a complete goal or with no goal", () => {
        assert.equal(
            expectError(
                transition(
                    makeSnapshot({ status: "complete" }),
                    { type: "block", reason: "stuck", evidence: [], auditTurns: 3 },
                    CONTEXT,
                ),
            )._tag,
            "InvalidTransitionError",
        );
        assert.equal(
            expectError(
                transition(
                    null,
                    { type: "block", reason: "stuck", evidence: [], auditTurns: 3 },
                    CONTEXT,
                ),
            )._tag,
            "GoalNotFoundError",
        );
    });
});

describe("system transitions", () => {
    test("budget-exhausted moves active to budgetLimited once", () => {
        const current = makeSnapshot();
        const outcome = expectOk(transition(current, { type: "budget-exhausted" }, CONTEXT));
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);
        assert.equal(snapshot.status, "budgetLimited");
        assert.equal(snapshot.statusChangedAt, NOW);
        assert.deepEqual(snapshot.history.at(-1), {
            at: NOW,
            from: "active",
            to: "budgetLimited",
            reason: "budget-exhausted",
        });
        assert.deepEqual(outcome.events, [
            {
                type: "goal.status-changed",
                goalId: "goal-1",
                from: "active",
                to: "budgetLimited",
                reason: "budget-exhausted",
                at: NOW,
            },
        ]);

        const noOp = expectOk(transition(snapshot, { type: "budget-exhausted" }, CONTEXT));
        assert.strictEqual(noOp.snapshot, snapshot);
        assert.equal(noOp.events.length, 0);
    });

    test("budget-exhausted rejects non-active, non-limited statuses", () => {
        const statuses: readonly GoalStatus[] = ["paused", "blocked", "usageLimited", "complete"];
        for (const status of statuses) {
            assert.equal(
                expectError(transition(makeSnapshot({ status }), { type: "budget-exhausted" }, CONTEXT))._tag,
                "InvalidTransitionError",
                `status ${status}`,
            );
        }
        assert.equal(
            expectError(transition(null, { type: "budget-exhausted" }, CONTEXT))._tag,
            "GoalNotFoundError",
        );
    });

    test("usage-limited moves active, paused, and blocked goals", () => {
        const sources: readonly GoalStatus[] = ["active", "paused", "blocked"];
        for (const status of sources) {
            const outcome = expectOk(
                transition(
                    makeSnapshot({ status }),
                    { type: "usage-limited", detail: "quota exhausted" },
                    CONTEXT,
                ),
            );
            const snapshot = outcome.snapshot;
            assert.ok(snapshot !== null);
            assert.equal(snapshot.status, "usageLimited", `status ${status}`);
            assert.equal(snapshot.pause, null);
            assert.equal(snapshot.block, null);
            assert.deepEqual(snapshot.history.at(-1), {
                at: NOW,
                from: status,
                to: "usageLimited",
                reason: "usage-limited",
                detail: "quota exhausted",
            });
        }
    });

    test("usage-limited is a no-op on limited goals and rejects a complete goal", () => {
        for (const status of ["budgetLimited", "usageLimited"] as const) {
            const current = makeSnapshot({ status });
            const outcome = expectOk(
                transition(current, { type: "usage-limited", detail: "quota" }, CONTEXT),
            );
            assert.strictEqual(outcome.snapshot, current);
        }
        assert.equal(
            expectError(
                transition(makeSnapshot({ status: "complete" }), { type: "usage-limited", detail: "quota" }, CONTEXT),
            )._tag,
            "InvalidTransitionError",
        );
    });

    test("provider-error pauses an active goal with its detail", () => {
        const outcome = expectOk(
            transition(
                makeSnapshot(),
                { type: "provider-error", detail: "502 from provider" },
                CONTEXT,
            ),
        );
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);
        assert.equal(snapshot.status, "paused");
        assert.deepEqual(snapshot.pause, {
            reason: "provider-error",
            detail: "502 from provider",
            at: NOW,
        });
    });

    test("interrupted pauses an active goal", () => {
        const snapshot = expectSnapshot(transition(makeSnapshot(), { type: "interrupted" }, CONTEXT));
        assert.equal(snapshot.status, "paused");
        assert.deepEqual(snapshot.pause, { reason: "interrupted", at: NOW });
        assert.equal(snapshot.history.at(-1)?.reason, "interrupted");
    });

    test("no-progress pauses an active goal and records the idle turns", () => {
        const snapshot = expectSnapshot(
            transition(makeSnapshot(), { type: "no-progress", idleTurns: 3 }, CONTEXT),
        );
        assert.equal(snapshot.status, "paused");
        assert.equal(snapshot.pause?.reason, "no-progress");
        assert.match(snapshot.pause?.detail ?? "", /3 goal turns/);
    });

    test("pause-type system signals preserve an existing pause reason", () => {
        const paused = makeSnapshot({ status: "paused", pause: { reason: "user", at: 50 } });
        const commands: readonly TransitionCommand[] = [
            { type: "provider-error", detail: "boom" },
            { type: "interrupted" },
            { type: "no-progress", idleTurns: 4 },
        ];
        for (const command of commands) {
            const outcome = expectOk(transition(paused, command, CONTEXT));
            assert.strictEqual(outcome.snapshot, paused, command.type);
            assert.equal(outcome.events.length, 0, command.type);
        }
    });

    test("pause-type system signals are no-ops on stopped non-paused goals", () => {
        for (const status of ["blocked", "usageLimited", "budgetLimited"] as const) {
            const current = makeSnapshot({ status });
            const outcome = expectOk(
                transition(current, { type: "provider-error", detail: "boom" }, CONTEXT),
            );
            assert.strictEqual(outcome.snapshot, current, `status ${status}`);
        }
    });

    test("pause-type system signals reject a complete goal", () => {
        const commands: readonly TransitionCommand[] = [
            { type: "provider-error", detail: "boom" },
            { type: "interrupted" },
            { type: "no-progress", idleTurns: 3 },
        ];
        for (const command of commands) {
            assert.equal(
                expectError(transition(makeSnapshot({ status: "complete" }), command, CONTEXT))._tag,
                "InvalidTransitionError",
                command.type,
            );
        }
    });

    test("forked pauses any non-complete goal with reason forked", () => {
        const active = expectOk(transition(makeSnapshot(), { type: "forked" }, CONTEXT));
        const activeSnapshot = active.snapshot;
        assert.ok(activeSnapshot !== null);
        assert.equal(activeSnapshot.status, "paused");
        assert.deepEqual(activeSnapshot.pause, { reason: "forked", at: NOW });
        assert.deepEqual(activeSnapshot.history.at(-1), {
            at: NOW,
            from: "active",
            to: "paused",
            reason: "forked",
        });
        assert.equal(active.events.length, 1);

        const paused = makeSnapshot({ status: "paused", pause: { reason: "user", at: 50 } });
        const forked = expectSnapshot(transition(paused, { type: "forked" }, CONTEXT));
        assert.equal(forked.status, "paused");
        assert.deepEqual(forked.pause, { reason: "forked", at: NOW });
        assert.equal(forked.statusChangedAt, paused.statusChangedAt);
        assert.equal(forked.history.at(-1)?.reason, "forked");
    });

    test("forked rejects a complete goal and no goal", () => {
        assert.equal(
            expectError(transition(makeSnapshot({ status: "complete" }), { type: "forked" }, CONTEXT))._tag,
            "InvalidTransitionError",
        );
        assert.equal(expectError(transition(null, { type: "forked" }, CONTEXT))._tag, "GoalNotFoundError");
    });
});

describe("touch", () => {
    test("accumulates active time with a revision bump and no history", () => {
        const current = makeSnapshot();
        const outcome = expectOk(transition(current, { type: "touch", activeMsDelta: 250 }, CONTEXT));
        const snapshot = outcome.snapshot;
        assert.ok(snapshot !== null);

        assert.equal(snapshot.activeMs, 750);
        assert.equal(snapshot.revision, 4);
        assert.equal(snapshot.updatedAt, NOW);
        assert.equal(snapshot.statusChangedAt, 200);
        assert.deepEqual(snapshot.history, current.history);
        assert.equal(outcome.events.length, 0);
    });

    test("clamps a negative delta to zero", () => {
        const snapshot = expectSnapshot(
            transition(makeSnapshot(), { type: "touch", activeMsDelta: -100 }, CONTEXT),
        );
        assert.equal(snapshot.activeMs, 500);
        assert.equal(snapshot.revision, 4);
    });

    test("rejects a complete goal and no goal", () => {
        assert.equal(
            expectError(
                transition(makeSnapshot({ status: "complete" }), { type: "touch", activeMsDelta: 10 }, CONTEXT),
            )._tag,
            "InvalidTransitionError",
        );
        assert.equal(
            expectError(transition(null, { type: "touch", activeMsDelta: 10 }, CONTEXT))._tag,
            "GoalNotFoundError",
        );
    });
});

describe("invariants", () => {
    test("history keeps at most 40 newest entries", () => {
        let snapshot = makeSnapshot();
        for (let i = 0; i < 45; i += 1) {
            snapshot = expectSnapshot(
                transition(
                    snapshot,
                    { type: "edit", objective: `Objective ${i}` },
                    withNow(NOW + i),
                ),
            );
        }

        assert.equal(snapshot.history.length, 40);
        assert.equal(snapshot.history[0]?.reason, "objective-edited");
        assert.equal(snapshot.history.at(-1)?.reason, "objective-edited");
        assert.equal(snapshot.history.at(-1)?.at, NOW + 44);
        assert.equal(snapshot.revision, 3 + 45);
        assert.equal(snapshot.objective, "Objective 44");
    });

    test("revision and statusChangedAt follow persisted changes only", () => {
        const created = expectSnapshot(
            transition(
                null,
                { type: "create", objective: "Goal", budgetTokens: 50 },
                withNow(1_000),
            ),
        );
        const edited = expectSnapshot(
            transition(created, { type: "edit", objective: "Goal v2" }, withNow(1_001)),
        );
        const budgeted = expectSnapshot(
            transition(edited, { type: "setBudget", budgetTokens: 60 }, withNow(1_002)),
        );
        const paused = expectSnapshot(
            transition(budgeted, { type: "pause", pauseReason: "user" }, withNow(1_003)),
        );
        const resumed = expectSnapshot(transition(paused, { type: "resume" }, withNow(1_004)));
        const limited = expectSnapshot(
            transition(resumed, { type: "budget-exhausted" }, withNow(1_005)),
        );
        const completed = expectSnapshot(
            transition(limited, { type: "complete", evidenceCount: 1 }, withNow(1_006)),
        );

        const timeline = [created, edited, budgeted, paused, resumed, limited, completed];
        timeline.forEach((snapshot, index) => {
            assert.equal(snapshot.revision, index + 1);
            assert.equal(snapshot.updatedAt, 1_000 + index);
        });

        assert.equal(created.statusChangedAt, 1_000);
        assert.equal(edited.statusChangedAt, 1_000);
        assert.equal(budgeted.statusChangedAt, 1_000);
        assert.equal(paused.statusChangedAt, 1_003);
        assert.equal(resumed.statusChangedAt, 1_004);
        assert.equal(limited.statusChangedAt, 1_005);
        assert.equal(completed.statusChangedAt, 1_006);
    });

    test("no-op successes do not bump the revision", () => {
        const limited = makeSnapshot({ status: "budgetLimited" });
        const paused = makeSnapshot({ status: "paused", pause: { reason: "user", at: 50 } });

        assert.strictEqual(
            expectOk(transition(limited, { type: "pause", pauseReason: "user" }, CONTEXT)).snapshot,
            limited,
        );
        assert.strictEqual(
            expectOk(transition(limited, { type: "block", reason: "stuck", evidence: [], auditTurns: 3 }, CONTEXT)).snapshot,
            limited,
        );
        assert.strictEqual(
            expectOk(transition(limited, { type: "budget-exhausted" }, CONTEXT)).snapshot,
            limited,
        );
        assert.strictEqual(
            expectOk(transition(paused, { type: "interrupted" }, CONTEXT)).snapshot,
            paused,
        );
        assert.equal(limited.revision, 3);
        assert.equal(paused.revision, 3);
    });

    test("never mutates the input snapshot", () => {
        const active = makeSnapshot({
            block: { reason: "old", evidence: ["a"], at: 60 },
        });
        const activeBefore = structuredClone(active);

        expectSnapshot(transition(active, { type: "pause", pauseReason: "user" }, CONTEXT));
        expectSnapshot(transition(active, { type: "edit", objective: "Changed" }, CONTEXT));
        expectSnapshot(
            transition(active, { type: "block", reason: "stuck", evidence: ["b"], auditTurns: 3 }, CONTEXT),
        );
        expectSnapshot(transition(active, { type: "touch", activeMsDelta: 10 }, CONTEXT));
        assert.deepEqual(active, activeBefore);

        const complete = makeSnapshot({ status: "complete" });
        const completeBefore = structuredClone(complete);
        expectSnapshot(
            transition(complete, { type: "create", objective: "Replacement", budgetTokens: null }, CONTEXT),
        );
        assert.deepEqual(complete, completeBefore);
    });

    test("complete is terminal for every command except create", () => {
        const complete = makeSnapshot({ status: "complete" });
        const terminalCommands: readonly TransitionCommand[] = [
            { type: "pause", pauseReason: "user" },
            { type: "resume" },
            { type: "edit", objective: "New" },
            { type: "setBudget", budgetTokens: 10 },
            { type: "complete", evidenceCount: 1 },
            { type: "block", reason: "stuck", evidence: [], auditTurns: 3 },
            { type: "budget-exhausted" },
            { type: "usage-limited", detail: "quota" },
            { type: "provider-error", detail: "boom" },
            { type: "interrupted" },
            { type: "no-progress", idleTurns: 3 },
            { type: "forked" },
            { type: "touch", activeMsDelta: 10 },
        ];

        for (const command of terminalCommands) {
            const result = transition(complete, command, CONTEXT);
            const error = expectError(result);
            assert.equal(error._tag, "InvalidTransitionError", command.type);
        }

        const replaced = expectSnapshot(
            transition(
                complete,
                { type: "create", objective: "Replacement", budgetTokens: null },
                CONTEXT,
            ),
        );
        assert.equal(replaced.status, "active");
        assert.equal(replaced.goalId, "goal-new");
    });
});

describe("validation helpers", () => {
    test("validateObjective trims before checking", () => {
        assert.equal(validateObjective("  valid  "), null);
        assert.equal(validateObjective("")?._tag, "GoalValidationError");
        assert.equal(validateObjective(" \n\t ")?._tag, "GoalValidationError");
        assert.equal(validateObjective("a".repeat(MAX_OBJECTIVE_CHARS + 1))?._tag, "GoalValidationError");
    });

    test("validateBudgetTokens accepts only null or positive integers", () => {
        assert.equal(validateBudgetTokens(null), null);
        assert.equal(validateBudgetTokens(1), null);
        assert.equal(validateBudgetTokens(0)?._tag, "GoalValidationError");
        assert.equal(validateBudgetTokens(-1)?._tag, "GoalValidationError");
        assert.equal(validateBudgetTokens(0.5)?._tag, "GoalValidationError");
        assert.equal(validateBudgetTokens(Number.POSITIVE_INFINITY)?._tag, "GoalValidationError");
    });
});

test("fork preserves a budget-limited goal and adopts the forked session id", () => {
    const limited = makeSnapshot({
        status: "budgetLimited",
        budgetTokens: 100,
    });
    const kept = expectOk(
        transition(limited, { type: "forked" }, { ...CONTEXT, sessionId: "session-fork" }),
    );
    assert.equal(kept.snapshot?.status, "budgetLimited");
    assert.equal(kept.snapshot?.sessionId, "session-fork");

    const active = makeSnapshot({ status: "active" });
    const paused = expectOk(
        transition(active, { type: "forked" }, { ...CONTEXT, sessionId: "session-fork" }),
    );
    assert.equal(paused.snapshot?.status, "paused");
    assert.equal(paused.snapshot?.pause?.reason, "forked");
    assert.equal(paused.snapshot?.sessionId, "session-fork");
});

test("resume from a pause is rejected while the budget is still exhausted", () => {
    const paused = makeSnapshot({ status: "paused", budgetTokens: 100 });
    const result = transition(
        paused,
        { type: "resume" },
        { ...CONTEXT, tokensUsed: 150 },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error._tag, "GoalRejectedError");
    if (result.error._tag !== "GoalRejectedError") return;
    assert.equal(result.error.code, "budget-exceeded");
});
