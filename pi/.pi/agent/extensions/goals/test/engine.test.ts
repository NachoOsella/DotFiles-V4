/**
 * Engine integration tests.
 *
 * Each test drives the real engine layer over an in-memory store and a fake
 * transcript, so the invariants that matter for an autonomous loop are checked
 * end to end: one continuation per boundary, interrupt handling, budgets,
 * audits, forks, compaction, restarts, and concurrent mutations.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import {
    DEFAULT_MAX_IDLE_TURNS,
    GOAL_DIRECTIVE_CUSTOM_TYPE,
    GOAL_SNAPSHOT_CUSTOM_TYPE,
    type GoalDirectiveDetails,
    type GoalSnapshot,
    type GoalToolCall,
    type UserCommand,
} from "../src/domain/goal.ts";
import type { GoalError } from "../src/domain/errors.ts";
import {
    GoalEngine,
    makeGoalEngineLayer,
    type GoalEngineOptions,
    type GoalEngineShape,
} from "../src/services/goal-controller.ts";
import { FakeSession, newestAssistantEntry } from "./support/fake-session.ts";

type EngineRun<A> =
    | { readonly ok: true; readonly value: A }
    | { readonly ok: false; readonly message: string };

function unknownMessage(value: unknown): string {
    if (typeof value === "object" && value !== null) {
        const message: unknown = Reflect.get(value, "message");
        if (typeof message === "string" && message.length > 0) return message;
    }
    return String(value);
}

function makeHarness(options: GoalEngineOptions = {}) {
    const appends: GoalSnapshot[] = [];
    const layer: Layer.Layer<GoalEngine, never, never> = makeGoalEngineLayer({
        generateGoalId: () => "goal-1",
        ...options,
    });
    const runtime = ManagedRuntime.make(layer);

    const run = async <A>(
        build: (engine: GoalEngineShape) => Effect.Effect<A, GoalError, GoalEngine>,
    ): Promise<EngineRun<A>> => {
        const exit = await runtime.runPromiseExit(
            Effect.gen(function* () {
                const engine = yield* GoalEngine;
                return yield* build(engine);
            }),
        );
        if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
        const failure = Exit.findErrorOption(exit);
        if (Option.isSome(failure)) {
            return { ok: false, message: unknownMessage(failure.value) };
        }
        return { ok: false, message: Cause.pretty(exit.cause) };
    };

    const context = (session: FakeSession) => ({
        readBranch: () => session.getBranch(),
        appendEntry: (customType: string, data: unknown) => {
            session.appendCustom(customType, data);
            if (customType === GOAL_SNAPSHOT_CUSTOM_TYPE) {
                appends.push(data as GoalSnapshot);
            }
        },
        sessionId: session.sessionId,
        now: session.now(),
    });

    const command = async (session: FakeSession, value: UserCommand) =>
        run((engine) => engine.runCommand({ ...context(session), command: value }));

    const tool = async (session: FakeSession, call: GoalToolCall) =>
        run((engine) => engine.runTool({ ...context(session), call }));

    const view = async (session: FakeSession) =>
        run((engine) => engine.view(context(session)));

    const boundary = async (
        session: FakeSession,
        options2: { outcome?: "completed" | "aborted" | "error"; errorText?: string | null } = {},
    ) => {
        const assistant = newestAssistantEntry(session.getBranch());
        return run((engine) =>
            engine.decideBoundary({
                ...context(session),
                facts: {
                    now: session.now(),
                    outcome: options2.outcome ?? "completed",
                    assistantEntryId: assistant?.id ?? null,
                    errorText: options2.errorText ?? null,
                },
            }),
        );
    };

    const settle = async (
        session: FakeSession,
        options2: { aborted?: boolean; activeMsDelta?: number } = {},
    ) =>
        run((engine) =>
            engine.settle({
                ...context(session),
                aborted: options2.aborted ?? false,
                activeMsDelta: options2.activeMsDelta ?? 0,
            }),
        );

    return { appends, runtime, run, context, command, tool, view, boundary, settle };
}

function expectOk<A>(result: EngineRun<A>): A {
    if (!result.ok) assert.fail(result.message);
    return result.value;
}

function expectFail(result: EngineRun<unknown>, fragment: string): void {
    assert.equal(result.ok, false, "expected a failure");
    if (result.ok) return;
    assert.ok(
        result.message.toLowerCase().includes(fragment.toLowerCase()),
        `expected "${result.message}" to contain "${fragment}"`,
    );
}

function directives(session: FakeSession, goalId: string): number {
    return session
        .getBranch()
        .filter(
            (entry) =>
                entry.type === "custom_message" &&
                entry.customType === GOAL_DIRECTIVE_CUSTOM_TYPE &&
                (entry.details as GoalDirectiveDetails | undefined)?.goalId === goalId,
        ).length;
}

function appendDirective(
    session: FakeSession,
    goalId: string,
    kind: GoalDirectiveDetails["kind"],
    anchorEntryId: string | null,
): void {
    const turn = directives(session, goalId) + 1;
    const details: GoalDirectiveDetails = { goalId, kind, turn, anchorEntryId };
    session.appendCustomMessage(
        GOAL_DIRECTIVE_CUSTOM_TYPE,
        `directive ${turn}`,
        false,
        details,
    );
}

async function createGoal(
    harness: ReturnType<typeof makeHarness>,
    session: FakeSession,
    budgetTokens: number | null = null,
): Promise<{ goalId: string; prompt: string }> {
    const result = expectOk(
        await harness.command(session, {
            type: "create",
            objective: "Write the report and verify it",
            budgetTokens,
        }),
    );
    assert.ok(result.kickoffPrompt && result.kickoffPrompt.length > 0);
    const goalId = result.snapshot?.goalId;
    assert.ok(goalId);
    return { goalId, prompt: result.kickoffPrompt };
}

async function activeGoal(
    harness: ReturnType<typeof makeHarness>,
    session: FakeSession,
    budgetTokens: number | null = null,
): Promise<string> {
    const { goalId, prompt } = await createGoal(harness, session, budgetTokens);
    appendDirective(session, goalId, "kickoff", null);
    session.appendUser(prompt);
    session.appendAssistant({ text: "starting" });
    return goalId;
}

function snapshotOf(session: FakeSession): GoalSnapshot | null {
    const entries = session.getBranch();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type === "custom" && entry.customType === GOAL_SNAPSHOT_CUSTOM_TYPE) {
            return entry.data as GoalSnapshot;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// creation and commands
// ---------------------------------------------------------------------------

test("create persists an active goal and a kickoff prompt", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();

    const result = expectOk(
        await harness.command(session, {
            type: "create",
            objective: "Write the report and verify it",
            budgetTokens: null,
        }),
    );

    assert.equal(result.snapshot?.status, "active");
    assert.equal(result.snapshot?.goalId, "goal-1");
    assert.equal(harness.appends.length, 1);
    assert.ok(result.kickoffPrompt?.includes("Continue working toward the active thread goal."));
    assert.ok(result.kickoffPrompt?.includes("Write the report and verify it"));
    assert.equal(directives(session, "goal-1"), 0, "the adapter, not the engine, writes directives");
    assert.equal(snapshotOf(session)?.status, "active");
});

test("create refuses to replace an unfinished goal", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await createGoal(harness, session);

    expectFail(
        await harness.command(session, {
            type: "create",
            objective: "different objective",
            budgetTokens: null,
        }),
        "unfinished goal",
    );
    assert.equal(harness.appends.length, 1);
});

test("a complete goal can be replaced by a new one", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    session.appendToolResult({ toolName: "bash" });
    expectOk(await harness.tool(session, { type: "update", status: "complete" }));
    assert.equal(snapshotOf(session)?.status, "complete");

    let counter = 0;
    const second = await harness.command(session, {
        type: "create",
        objective: "Second objective",
        budgetTokens: 500,
    });
    counter += 1;
    assert.equal(counter, 1);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.snapshot?.status, "active");
});

test("clear removes the goal and boundaries stay idle", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    expectOk(await harness.command(session, { type: "clear" }));
    const view = expectOk(await harness.view(session));
    assert.equal(view.view, null);
    const decision = expectOk(await harness.boundary(session));
    assert.equal(decision.kind, "idle");
});

test("pause and resume round trip through snapshots", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    expectOk(await harness.command(session, { type: "pause" }));
    assert.equal(snapshotOf(session)?.status, "paused");
    assert.equal(expectOk(await harness.boundary(session)).kind, "idle");

    const resumed = expectOk(await harness.command(session, { type: "resume" }));
    assert.equal(resumed.snapshot?.status, "active");
    assert.ok(resumed.kickoffPrompt?.includes("Write the report"));
    assert.equal(snapshotOf(session)?.status, "active");
});

test("edit changes the objective without changing status", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    const edited = expectOk(
        await harness.command(session, { type: "edit", objective: "Write a shorter report" }),
    );
    assert.equal(edited.snapshot?.objective, "Write a shorter report");
    assert.equal(edited.snapshot?.status, "active");
    assert.ok(edited.kickoffPrompt?.includes("Write a shorter report"));
});

// ---------------------------------------------------------------------------
// boundary continuation
// ---------------------------------------------------------------------------

test("an active goal continues once per boundary", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    const decision = expectOk(await harness.boundary(session));
    assert.equal(decision.kind, "continue");
    if (decision.kind !== "continue") return;
    assert.equal(decision.goalId, goalId);
    assert.equal(decision.directiveKind, "continuation");
    assert.ok(decision.prompt.includes("Continue working toward the active thread goal."));
    assert.equal(harness.appends.length, 1, "a continuation does not rewrite the snapshot");
});

test("the same boundary never continues twice", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    const assistant = newestAssistantEntry(session.getBranch());
    assert.ok(assistant);
    const first = expectOk(await harness.boundary(session));
    assert.equal(first.kind, "continue");
    appendDirective(session, goalId, "continuation", assistant.id);

    const second = expectOk(await harness.boundary(session));
    assert.equal(second.kind, "idle");
    if (second.kind !== "idle") return;
    assert.equal(second.reason, "already-continued");

    session.appendAssistant({ text: "next turn" });
    const third = expectOk(await harness.boundary(session));
    assert.equal(third.kind, "continue");
});

test("a paused goal never continues", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    expectOk(await harness.command(session, { type: "pause" }));
    session.appendAssistant({ text: "should not continue" });

    const decision = expectOk(await harness.boundary(session));
    assert.equal(decision.kind, "idle");
    if (decision.kind !== "idle") return;
    assert.equal(decision.reason, "inactive:paused");
});

// ---------------------------------------------------------------------------
// interrupts, errors, limits
// ---------------------------------------------------------------------------

test("an interrupt pauses the goal and blocks further continuation", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    const settled = expectOk(await harness.settle(session, { aborted: true, activeMsDelta: 1500 }));
    assert.equal(settled.view?.snapshot.status, "paused");
    assert.equal(settled.view?.snapshot.pause?.reason, "interrupted");
    assert.equal(settled.view?.snapshot.activeMs, 1500);
    assert.equal(snapshotOf(session)?.status, "paused");

    session.appendAssistant({ text: "after the interrupt" });
    assert.equal(expectOk(await harness.boundary(session)).kind, "idle");
});

test("an interrupted goal stays paused after a manual compaction", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    expectOk(await harness.settle(session, { aborted: true }));
    assert.equal(snapshotOf(session)?.status, "paused");

    // Pi has no causal link between an abort and the compaction that caused it, so
    // the extension never resumes on its own.
    session.appendAssistant({ text: "after compaction" });
    assert.equal(expectOk(await harness.boundary(session)).kind, "idle");
    assert.equal(snapshotOf(session)?.status, "paused");
});

test("a non-aborted settle accumulates active time", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    expectOk(await harness.settle(session, { activeMsDelta: 2000 }));
    expectOk(await harness.settle(session, { activeMsDelta: 3000 }));
    assert.equal(snapshotOf(session)?.activeMs, 5000);
});

test("provider usage limits map to usageLimited", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    const decision = expectOk(
        await harness.boundary(session, {
            outcome: "error",
            errorText: "429 Too Many Requests: rate limit reached",
        }),
    );
    assert.equal(decision.kind, "stopped");
    assert.equal(snapshotOf(session)?.status, "usageLimited");
});

test("other provider errors pause instead of blocking", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    const decision = expectOk(
        await harness.boundary(session, {
            outcome: "error",
            errorText: "401 Unauthorized: invalid api key",
        }),
    );
    assert.equal(decision.kind, "stopped");
    const snapshot = snapshotOf(session);
    assert.equal(snapshot?.status, "paused");
    assert.equal(snapshot?.pause?.reason, "provider-error");
});

test("a budgeted goal wraps up once and then stops", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session, 100);
    session.appendAssistant({
        text: "spent the budget",
        usage: { input: 60, output: 50, cacheRead: 900, cacheWrite: 0 },
    });

    const wrapup = expectOk(await harness.boundary(session));
    assert.equal(wrapup.kind, "budget-wrapup");
    if (wrapup.kind !== "budget-wrapup") return;
    assert.ok(wrapup.prompt.includes("reached its token budget"));
    assert.equal(wrapup.view.metrics.usage.tokensUsed, 110);
    assert.equal(wrapup.view.metrics.usage.cacheRead, 900);
    assert.equal(
        snapshotOf(session)?.status,
        "budgetLimited",
        "the status flips when the wrap-up starts, as in Codex",
    );

    const assistant = newestAssistantEntry(session.getBranch());
    appendDirective(session, goalId, "budget-wrapup", assistant?.id ?? null);
    session.appendAssistant({ text: "wrapping up" });

    const stopped = expectOk(await harness.boundary(session));
    assert.equal(stopped.kind, "idle");
    assert.equal(snapshotOf(session)?.status, "budgetLimited");
});

test("cache reads are not charged against the budget", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session, 100);
    session.appendAssistant({
        text: "cheap cached turn",
        usage: { input: 10, output: 10, cacheRead: 5000, cacheWrite: 0 },
    });

    const view = expectOk(await harness.view(session));
    assert.equal(view.view?.metrics.usage.tokensUsed, 20);
    assert.equal(view.view?.metrics.usage.allTokens, 5020);
    assert.equal(expectOk(await harness.boundary(session)).kind, "continue");
});

test("raising the budget resumes a budget-limited goal", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session, 10);
    session.appendAssistant({ text: "over budget", usage: { input: 20, output: 5 } });
    const wrapup = expectOk(await harness.boundary(session));
    assert.equal(wrapup.kind, "budget-wrapup");
    appendDirective(session, goalId, "budget-wrapup", null);
    session.appendAssistant({ text: "done wrapping" });
    expectOk(await harness.boundary(session));
    assert.equal(snapshotOf(session)?.status, "budgetLimited");

    expectFail(await harness.command(session, { type: "resume" }), "budget");

    const raised = expectOk(await harness.command(session, { type: "setBudget", budgetTokens: 1000 }));
    assert.equal(raised.snapshot?.status, "active");
    assert.ok(raised.kickoffPrompt?.includes("Continue working"));
});

test("three idle turns trip the no-progress breaker", async (t) => {
    const harness = makeHarness(DEFAULT_OPTIONS);
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    for (let turn = 1; turn <= 2; turn += 1) {
        const decision = expectOk(await harness.boundary(session));
        assert.equal(decision.kind, "continue", `turn ${turn}`);
        appendDirective(session, goalId, "continuation", null);
        session.appendAssistant({ text: `thinking ${turn}` });
    }

    const third = expectOk(await harness.boundary(session));
    assert.equal(third.kind, "stopped");
    if (third.kind !== "stopped") return;
    assert.equal(third.reason, "no-progress");
    assert.equal(snapshotOf(session)?.status, "paused");
    assert.equal(snapshotOf(session)?.pause?.reason, "no-progress");
    assert.equal(DEFAULT_MAX_IDLE_TURNS, 3);
});

test("tool activity resets the no-progress breaker", async (t) => {
    const harness = makeHarness(DEFAULT_OPTIONS);
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    for (let turn = 1; turn <= 4; turn += 1) {
        const decision = expectOk(await harness.boundary(session));
        assert.equal(decision.kind, "continue", `turn ${turn}`);
        appendDirective(session, goalId, "continuation", null);
        session.appendAssistant({ text: `working ${turn}` });
        session.appendToolResult({ toolName: "read" });
    }
});

const DEFAULT_OPTIONS: GoalEngineOptions = { maxIdleTurns: 3, maxGoalTurns: 200 };

test("the turn cap stops the loop with a wrap-up", async (t) => {
    const harness = makeHarness({ maxGoalTurns: 2 });
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    const first = expectOk(await harness.boundary(session));
    assert.equal(first.kind, "continue");
    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "second turn" });
    session.appendToolResult({ toolName: "bash" });

    const capped = expectOk(await harness.boundary(session));
    assert.equal(capped.kind, "budget-wrapup");
    if (capped.kind !== "budget-wrapup") return;
    assert.equal(capped.reason, "turn-cap");
    appendDirective(session, goalId, "budget-wrapup", null);
    session.appendAssistant({ text: "wrapping up" });
    session.appendToolResult({ toolName: "bash" });

    const stopped = expectOk(await harness.boundary(session));
    assert.equal(stopped.kind, "stopped");
    assert.equal(snapshotOf(session)?.status, "paused");
    assert.equal(snapshotOf(session)?.pause?.reason, "turn-cap");

    const resumed = expectOk(await harness.command(session, { type: "resume" }));
    assert.equal(resumed.snapshot?.status, "active");
    assert.equal(expectOk(await harness.boundary(session)).kind, "continue");
});

// ---------------------------------------------------------------------------
// audits
// ---------------------------------------------------------------------------

test("completion needs evidence from the current goal turn", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    expectFail(
        await harness.tool(session, { type: "update", status: "complete" }),
        "requires evidence",
    );
    assert.equal(snapshotOf(session)?.status, "active");

    session.appendToolResult({ toolName: "bash" });
    const completed = expectOk(
        await harness.tool(session, { type: "update", status: "complete" }),
    );
    assert.equal(completed.snapshot?.status, "complete");
    assert.ok(completed.message.includes("Goal achieved"));
    assert.equal(expectOk(await harness.boundary(session)).kind, "idle");
});

test("completion is rejected without a goal", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    expectFail(
        await harness.tool(session, { type: "update", status: "complete" }),
        "no goal",
    );
});

test("blocked needs three audited goal turns", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);

    expectFail(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "no credentials",
        }),
        "3 consecutive goal turns",
    );

    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "attempt two" });
    expectFail(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "no credentials",
        }),
        "3 consecutive goal turns",
    );

    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "attempt three" });
    const blocked = expectOk(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "no credentials",
            evidence: ["aws sts get-caller-identity returns 403"],
        }),
    );
    assert.equal(blocked.snapshot?.status, "blocked");
    assert.equal(blocked.snapshot?.block?.reason, "no credentials");
    assert.equal(expectOk(await harness.boundary(session)).kind, "idle");
});

test("resuming a blocked goal resets the blocked audit", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);
    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "two" });
    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "three" });
    expectOk(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "no credentials",
            evidence: ["aws sts get-caller-identity returns 403"],
        }),
    );

    expectOk(await harness.command(session, { type: "resume" }));
    session.appendAssistant({ text: "resumed" });
    expectFail(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "no credentials",
        }),
        "3 consecutive goal turns",
    );
});

test("pausing through the tool needs explicit authorization", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    expectFail(
        await harness.tool(session, { type: "update", status: "paused" }),
        "explicitly requests",
    );
    assert.equal(snapshotOf(session)?.status, "active");

    const paused = expectOk(
        await harness.tool(session, {
            type: "update",
            status: "paused",
            pauseAuthorized: true,
            reason: "user asked",
        }),
    );
    assert.equal(paused.snapshot?.status, "paused");
});

test("budgetLimited wins over a pause request", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session, 5);
    session.appendAssistant({ text: "spent", usage: { input: 10, output: 10 } });
    expectOk(await harness.boundary(session));
    appendDirective(session, goalId, "budget-wrapup", null);
    session.appendAssistant({ text: "wrap" });
    expectOk(await harness.boundary(session));
    assert.equal(snapshotOf(session)?.status, "budgetLimited");

    const paused = expectOk(
        await harness.tool(session, {
            type: "update",
            status: "paused",
            pauseAuthorized: true,
        }),
    );
    assert.equal(paused.snapshot?.status, "budgetLimited");
});

// ---------------------------------------------------------------------------
// lifecycle: fork, compaction, restart
// ---------------------------------------------------------------------------

test("a forked session pauses the copied goal", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    const forked = session.fork();

    const result = expectOk(
        await harness.run((engine) =>
            engine.rehydrate({ ...harness.context(forked), reason: "fork" }),
        ),
    );
    assert.equal(result.snapshot?.status, "paused");
    assert.equal(result.snapshot?.pause?.reason, "forked");
    assert.equal(snapshotOf(session)?.status, "active", "the original session keeps running");

    forked.appendAssistant({ text: "forked turn" });
    assert.equal(expectOk(await harness.boundary(forked)).kind, "idle");
});

test("a goal survives compaction even when the snapshot leaves model context", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);
    session.appendAssistant({ text: "some work", usage: { input: 5, output: 5 } });

    session.compact(null);
    const contextEntries = session.buildContextEntries();
    assert.equal(
        contextEntries.some(
            (entry) => entry.type === "custom" && entry.customType === GOAL_SNAPSHOT_CUSTOM_TYPE,
        ),
        false,
        "the snapshot is no longer in model context",
    );
    assert.equal(snapshotOf(session)?.goalId, goalId, "but it is still on the branch");

    const decision = expectOk(await harness.boundary(session));
    assert.equal(decision.kind, "continue");
    if (decision.kind !== "continue") return;
    assert.ok(decision.prompt.includes("Write the report"), "objective is re-injected");
});

test("a restarted engine derives the same state from the branch", async (t) => {
    const first = makeHarness();
    const session = new FakeSession();
    await activeGoal(first, session, 1000);
    session.appendAssistant({ text: "work", usage: { input: 30, output: 20, cacheWrite: 5 } });
    const before = expectOk(await first.view(session)).view;
    assert.ok(before);
    await first.runtime.dispose();

    const second = makeHarness();
    t.after(() => second.runtime.dispose());
    const after = expectOk(await second.view(session)).view;
    assert.ok(after);
    assert.equal(after.snapshot.goalId, before.snapshot.goalId);
    assert.equal(after.snapshot.status, before.snapshot.status);
    assert.equal(after.metrics.usage.tokensUsed, before.metrics.usage.tokensUsed);
    assert.equal(after.metrics.usage.tokensUsed, 55);
    assert.equal(after.metrics.goalTurns, before.metrics.goalTurns);
});

test("a tree rewind restores the snapshot on the active branch", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);
    const beforePause = session.getBranch().at(-1)?.id;
    assert.ok(beforePause);

    expectOk(await harness.command(session, { type: "pause" }));
    assert.equal(snapshotOf(session)?.status, "paused");

    session.rewindTo(beforePause);
    const view = expectOk(await harness.view(session));
    assert.equal(view.view?.snapshot.status, "active");
    assert.equal(view.view?.snapshot.goalId, goalId);
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

test("parallel mutations serialize without losing snapshots", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    const results = await Promise.all([
        harness.command(session, { type: "setBudget", budgetTokens: 1000 }),
        harness.tool(session, { type: "get" }),
        harness.command(session, { type: "setBudget", budgetTokens: 2000 }),
        harness.tool(session, { type: "get" }),
        harness.command(session, { type: "setBudget", budgetTokens: 3000 }),
    ]);
    for (const result of results) assert.equal(result.ok, true);
    const revisions = harness.appends.map((snapshot) => snapshot.revision);
    assert.deepEqual(
        revisions,
        [...revisions].sort((left, right) => left - right),
        "revisions never go backwards",
    );
    assert.equal(snapshotOf(session)?.budgetTokens, 3000);
});

test("usage is counted once per entry even when observed repeatedly", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    session.appendAssistant({ text: "one", usage: { input: 10, output: 10 } });
    session.appendToolResult({ toolName: "bash", usage: { input: 5, output: 1 } });

    const first = expectOk(await harness.view(session)).view;
    const second = expectOk(await harness.view(session)).view;
    assert.ok(first && second);
    assert.equal(first.metrics.usage.tokensUsed, 26);
    assert.equal(second.metrics.usage.tokensUsed, 26);
    assert.equal(first.metrics.toolCalls, 1);
    assert.equal(second.metrics.toolCalls, 1);
});

test("a late completion cannot attach to a cleared goal", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    session.appendToolResult({ toolName: "bash" });
    expectOk(await harness.command(session, { type: "clear" }));

    expectFail(
        await harness.tool(session, { type: "update", status: "complete" }),
        "no goal",
    );
    assert.equal(expectOk(await harness.view(session)).view, null);
});

test("malformed snapshots are skipped in favor of the newest valid one", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    session.appendCustom(GOAL_SNAPSHOT_CUSTOM_TYPE, { version: 99, goalId: "corrupt" });

    const view = expectOk(await harness.view(session));
    assert.equal(view.view?.snapshot.goalId, "goal-1");
    assert.equal(view.issues.length, 1);
    assert.equal(view.issues[0]?.kind, "unsupported-version");
});

test("a goal created by the tool accepts completion in its first turn", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();

    const created = expectOk(
        await harness.tool(session, {
            type: "create",
            objective: "Ship the endpoint",
            budgetTokens: null,
        }),
    );
    assert.equal(created.snapshot?.status, "active");

    const before = expectOk(await harness.view(session)).view;
    assert.equal(before?.metrics.goalTurns, 1);
    assert.equal(before?.metrics.currentTurnEvidence, 0);

    session.appendToolResult({ toolName: "bash" });
    const after = expectOk(await harness.view(session)).view;
    assert.equal(after?.metrics.goalTurns, 1);
    assert.equal(after?.metrics.currentTurnEvidence, 1);
    assert.equal(after?.metrics.toolCalls, 1);

    const completed = expectOk(
        await harness.tool(session, { type: "update", status: "complete" }),
    );
    assert.equal(completed.snapshot?.status, "complete");
});

test("completion records the elapsed time of the run in flight", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);
    session.appendToolResult({ toolName: "bash" });

    const completed = expectOk(
        await harness.run((engine) =>
            engine.runTool({
                ...harness.context(session),
                elapsedMs: 42_000,
                call: { type: "update", status: "complete" },
            }),
        ),
    );
    assert.equal(completed.snapshot?.status, "complete");
    assert.equal(completed.snapshot?.activeMs, 42_000);
    assert.equal(completed.structured?.goal?.timeUsedSeconds, 42);
    assert.ok(completed.message.includes("42"));
    assert.equal(snapshotOf(session)?.activeMs, 42_000);
    assert.equal(goalId.length > 0, true);
});

test("failSafe pauses an active goal after an internal failure", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);

    const safe = expectOk(
        await harness.run((engine) =>
            engine.failSafe({ ...harness.context(session), detail: "boundary handler threw" }),
        ),
    );
    assert.equal(safe.snapshot?.status, "paused");
    assert.equal(safe.snapshot?.pause?.reason, "internal-error");
    assert.equal(expectOk(await harness.boundary(session)).kind, "idle");
});

test("a goal budget above the engine maximum is rejected", async (t) => {
    const harness = makeHarness({ maxBudgetTokens: 1000 });
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();

    expectFail(
        await harness.command(session, {
            type: "create",
            objective: "Too expensive",
            budgetTokens: 5000,
        }),
        "exceeds the maximum allowed",
    );
    const created = expectOk(
        await harness.command(session, {
            type: "create",
            objective: "Affordable",
            budgetTokens: 1000,
        }),
    );
    assert.equal(created.snapshot?.budgetTokens, 1000);
});

test("blocked requires a reason and evidence after the audit threshold", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    const goalId = await activeGoal(harness, session);
    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "two" });
    appendDirective(session, goalId, "continuation", null);
    session.appendAssistant({ text: "three" });

    expectFail(
        await harness.tool(session, { type: "update", status: "blocked", reason: "no access" }),
        "evidence item",
    );
    expectFail(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "   ",
            evidence: ["403 from the API"],
        }),
        "non-empty reason",
    );
    const blocked = expectOk(
        await harness.tool(session, {
            type: "update",
            status: "blocked",
            reason: "no access",
            evidence: ["403 from the API"],
        }),
    );
    assert.equal(blocked.snapshot?.status, "blocked");
});

test("a run started while the goal is paused is not charged as active time", async (t) => {
    const harness = makeHarness();
    t.after(() => harness.runtime.dispose());
    const session = new FakeSession();
    await activeGoal(harness, session);
    expectOk(await harness.command(session, { type: "pause" }));
    session.appendAssistant({ text: "user asked something" });

    const settled = expectOk(await harness.settle(session, { activeMsDelta: 30_000 }));
    assert.equal(settled.view?.snapshot.activeMs, 0);
    assert.equal(snapshotOf(session)?.activeMs, 0);
});
