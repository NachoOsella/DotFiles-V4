import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
    BoundaryFacts,
    GoalMetrics,
    GoalSnapshot,
    GoalStatus,
    GoalUsageTotals,
    GoalView,
} from "../src/domain/goal.ts";
import {
    classifyFailure,
    decideContinuation,
    type PolicyInput,
    type PolicyOutcome,
} from "../src/services/continuation-policy.ts";

const EMPTY_USAGE: GoalUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tokensUsed: 0,
    allTokens: 0,
    costTotal: 0,
};

function makeSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    return {
        version: 1,
        goalId: "goal-1",
        sessionId: "session-1",
        revision: 1,
        status: "active",
        objective: "Ship the goal policy",
        budgetTokens: null,
        usageStartEntryId: null,
        createdAt: 1_000,
        updatedAt: 2_000,
        statusChangedAt: 2_000,
        activeMs: 5_000,
        turnBaseline: 0,
        pause: null,
        block: null,
        completion: { attempts: 0, lastRequestedAt: null, verifiedAt: null },
        history: [],
        ...overrides,
    };
}

function makeMetrics(overrides: Partial<GoalMetrics> = {}): GoalMetrics {
    return {
        usage: EMPTY_USAGE,
        remainingTokens: null,
        goalTurns: 2,
        auditedTurns: 0,
        continuationCount: 1,
        wrapupCount: 0,
        toolCalls: 4,
        failedToolCalls: 0,
        currentTurnEvidence: 1,
        currentTurnMutated: false,
        idleTurns: 0,
        activeMs: 5_000,
        directivePending: false,
        lastDirectiveEntryId: null,
        lastDirectiveAnchorId: null,
        ...overrides,
    };
}

interface ViewOptions {
    readonly snapshot?: Partial<GoalSnapshot>;
    readonly metrics?: Partial<GoalMetrics>;
}

function makeView(options: ViewOptions = {}): GoalView {
    return {
        snapshot: makeSnapshot(options.snapshot ?? {}),
        metrics: makeMetrics(options.metrics ?? {}),
    };
}

function makeFacts(overrides: Partial<BoundaryFacts> = {}): BoundaryFacts {
    return {
        now: 3_000,
        outcome: "completed",
        assistantEntryId: null,
        errorText: null,
        ...overrides,
    };
}

interface InputOptions extends ViewOptions {
    readonly view?: GoalView | null;
    readonly facts?: Partial<BoundaryFacts>;
    readonly maxGoalTurns?: number;
    readonly maxIdleTurns?: number;
}

interface Harness {
    readonly input: PolicyInput;
    readonly continuationViews: GoalView[];
    readonly wrapUpViews: GoalView[];
}

function makeHarness(options: InputOptions = {}): Harness {
    const continuationViews: GoalView[] = [];
    const wrapUpViews: GoalView[] = [];
    const view = "view" in options ? (options.view ?? null) : makeView(options);
    const input: PolicyInput = {
        view,
        facts: makeFacts(options.facts ?? {}),
        maxGoalTurns: options.maxGoalTurns ?? 200,
        maxIdleTurns: options.maxIdleTurns ?? 3,
        buildContinuationPrompt: (current) => {
            continuationViews.push(current);
            return `continuation:${current.snapshot.objective}`;
        },
        buildWrapUpPrompt: (current) => {
            wrapUpViews.push(current);
            return `wrapup:${current.snapshot.objective}`;
        },
    };
    return { input, continuationViews, wrapUpViews };
}

function expectIdle(outcome: PolicyOutcome) {
    if (outcome.kind !== "idle") assert.fail(`expected idle, got ${outcome.kind}`);
    return outcome;
}

function expectContinue(outcome: PolicyOutcome) {
    if (outcome.kind !== "continue") assert.fail(`expected continue, got ${outcome.kind}`);
    return outcome;
}

function expectWrapUp(outcome: PolicyOutcome) {
    if (outcome.kind !== "budget-wrapup") assert.fail(`expected budget-wrapup, got ${outcome.kind}`);
    return outcome;
}

function expectTransition(outcome: PolicyOutcome) {
    if (outcome.kind !== "transition") assert.fail(`expected transition, got ${outcome.kind}`);
    return outcome;
}

test("no goal yields idle no-goal", () => {
    const { input } = makeHarness({ view: null });
    assert.equal(expectIdle(decideContinuation(input)).reason, "no-goal");
});

const INACTIVE_STATUSES: readonly GoalStatus[] = [
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
];

for (const status of INACTIVE_STATUSES) {
    test(`status ${status} yields idle without a transition`, () => {
        const { input } = makeHarness({ snapshot: { status } });
        assert.equal(expectIdle(decideContinuation(input)).reason, `inactive:${status}`);
    });
}

test("aborted outcome pauses the goal as interrupted", () => {
    const { input } = makeHarness({
        facts: { outcome: "aborted", assistantEntryId: "assistant-1" },
    });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "interrupted");
    assert.deepEqual(outcome.command, { type: "interrupted" });
    assert.match(outcome.notice, /paused after interrupt/);
    assert.match(outcome.notice, /\/goal resume/);
});

test("usage-limit error transitions to usage-limited", () => {
    const errorText = "429 Too Many Requests: rate limit exceeded";
    const { input } = makeHarness({ facts: { outcome: "error", errorText } });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "usage-limit");
    assert.deepEqual(outcome.command, { type: "usage-limited", detail: errorText });
    assert.match(outcome.notice, /usage limit/);
    assert.match(outcome.notice, /\/goal resume/);
});

test("auth error transitions to provider-error", () => {
    const errorText = "401 Unauthorized: invalid api key";
    const { input } = makeHarness({ facts: { outcome: "error", errorText } });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "provider-error");
    assert.deepEqual(outcome.command, { type: "provider-error", detail: errorText });
    assert.match(outcome.notice, /paused after a provider error/);
    assert.match(outcome.notice, /\/goal resume/);
});

test("transient 500 error still pauses instead of retrying", () => {
    const errorText = "500 Internal Server Error";
    const { input } = makeHarness({ facts: { outcome: "error", errorText } });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "provider-error");
    assert.deepEqual(outcome.command, { type: "provider-error", detail: errorText });
});

test("error without text keeps a stable provider-error detail", () => {
    const { input } = makeHarness({ facts: { outcome: "error", errorText: null } });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "provider-error");
    assert.deepEqual(outcome.command, { type: "provider-error", detail: "provider error" });
});

test("duplicate boundary guard hits when the anchor matches", () => {
    const { input, continuationViews } = makeHarness({
        metrics: { directivePending: true, lastDirectiveAnchorId: "assistant-1" },
        facts: { assistantEntryId: "assistant-1" },
    });
    assert.equal(expectIdle(decideContinuation(input)).reason, "already-continued");
    assert.equal(continuationViews.length, 0);
});

test("duplicate boundary guard misses when the anchor differs", () => {
    const { input } = makeHarness({
        metrics: { directivePending: true, lastDirectiveAnchorId: "assistant-1" },
        facts: { assistantEntryId: "assistant-2" },
    });
    assert.equal(expectContinue(decideContinuation(input)).reason, "active");
});

test("duplicate boundary guard misses when no directive is pending", () => {
    const { input } = makeHarness({
        metrics: { directivePending: false, lastDirectiveAnchorId: "assistant-1" },
        facts: { assistantEntryId: "assistant-1" },
    });
    assert.equal(expectContinue(decideContinuation(input)).reason, "active");
});

test("duplicate boundary guard misses when the assistant entry is unknown", () => {
    const { input } = makeHarness({
        metrics: { directivePending: true, lastDirectiveAnchorId: "assistant-1" },
        facts: { assistantEntryId: null },
    });
    assert.equal(expectContinue(decideContinuation(input)).reason, "active");
});

test("idle breaker below the threshold continues", () => {
    const { input } = makeHarness({ metrics: { idleTurns: 2 }, maxIdleTurns: 3 });
    assert.equal(expectContinue(decideContinuation(input)).reason, "active");
});

test("idle breaker at the threshold transitions to no-progress", () => {
    const { input } = makeHarness({ metrics: { idleTurns: 3 }, maxIdleTurns: 3 });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "no-progress");
    assert.deepEqual(outcome.command, { type: "no-progress", idleTurns: 3 });
    assert.match(outcome.notice, /No tool activity was observed for 3 goal turns/);
});

test("first budget crossing produces one wrap-up turn", () => {
    const view = makeView({
        snapshot: { budgetTokens: 1_000 },
        metrics: { usage: { ...EMPTY_USAGE, tokensUsed: 1_000 } },
    });
    const { input, continuationViews, wrapUpViews } = makeHarness({ view });
    const outcome = expectWrapUp(decideContinuation(input));
    assert.equal(outcome.reason, "budget");
    assert.equal(outcome.prompt, `wrapup:${view.snapshot.objective}`);
    assert.equal(wrapUpViews.length, 1);
    assert.equal(wrapUpViews[0], view);
    assert.equal(continuationViews.length, 0);
});

test("budget stays limited after the wrap-up turn", () => {
    const view = makeView({
        snapshot: { budgetTokens: 1_000 },
        metrics: { wrapupCount: 1, usage: { ...EMPTY_USAGE, tokensUsed: 1_250 } },
    });
    const { input } = makeHarness({ view });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "budget");
    assert.deepEqual(outcome.command, { type: "budget-exhausted" });
    assert.match(outcome.notice, /1250 of 1000 tokens/);
});

test("unlimited budget never trips the budget breaker", () => {
    const { input } = makeHarness({
        snapshot: { budgetTokens: null },
        metrics: { usage: { ...EMPTY_USAGE, tokensUsed: 10_000_000 } },
    });
    assert.equal(expectContinue(decideContinuation(input)).reason, "active");
});

test("turn cap produces a wrap-up turn before limiting", () => {
    const view = makeView({ metrics: { goalTurns: 5, auditedTurns: 5, wrapupCount: 0 } });
    const { input, continuationViews, wrapUpViews } = makeHarness({ view, maxGoalTurns: 5 });
    const outcome = expectWrapUp(decideContinuation(input));
    assert.equal(outcome.reason, "turn-cap");
    assert.equal(outcome.prompt, `wrapup:${view.snapshot.objective}`);
    assert.equal(wrapUpViews.length, 1);
    assert.equal(continuationViews.length, 0);
});

test("turn cap limits the goal after the wrap-up turn", () => {
    const { input } = makeHarness({
        metrics: { goalTurns: 5, auditedTurns: 5, wrapupCount: 1 },
        maxGoalTurns: 5,
    });
    const outcome = expectTransition(decideContinuation(input));
    assert.equal(outcome.reason, "turn-cap");
    assert.deepEqual(outcome.command, {
        type: "pause",
        pauseReason: "turn-cap",
        detail: "5 of 5 goal turns",
    });
    assert.match(outcome.notice, /5 of 5 goal turns/);
});

test("normal boundary uses the injected continuation prompt with the view", () => {
    const view = makeView({ metrics: { goalTurns: 3, idleTurns: 0 } });
    const { input, continuationViews, wrapUpViews } = makeHarness({ view });
    const outcome = expectContinue(decideContinuation(input));
    assert.equal(outcome.reason, "active");
    assert.equal(outcome.prompt, `continuation:${view.snapshot.objective}`);
    assert.equal(continuationViews.length, 1);
    assert.equal(continuationViews[0], view);
    assert.equal(wrapUpViews.length, 0);
});

test("interrupt wins over the duplicate-boundary guard", () => {
    const { input } = makeHarness({
        metrics: { directivePending: true, lastDirectiveAnchorId: "assistant-1" },
        facts: { outcome: "aborted", assistantEntryId: "assistant-1" },
    });
    assert.equal(expectTransition(decideContinuation(input)).reason, "interrupted");
});

test("provider error wins over the duplicate-boundary guard", () => {
    const { input } = makeHarness({
        metrics: { directivePending: true, lastDirectiveAnchorId: "assistant-1" },
        facts: { outcome: "error", errorText: "401 Unauthorized", assistantEntryId: "assistant-1" },
    });
    assert.equal(expectTransition(decideContinuation(input)).reason, "provider-error");
});

test("inactive status wins over an aborted outcome", () => {
    const { input } = makeHarness({
        snapshot: { status: "paused" },
        facts: { outcome: "aborted" },
    });
    assert.equal(expectIdle(decideContinuation(input)).reason, "inactive:paused");
});

test("budget breaker wins over the turn cap", () => {
    const view = makeView({
        snapshot: { budgetTokens: 100 },
        metrics: { goalTurns: 5, wrapupCount: 0, usage: { ...EMPTY_USAGE, tokensUsed: 100 } },
    });
    const { input } = makeHarness({ view, maxGoalTurns: 5 });
    assert.equal(expectWrapUp(decideContinuation(input)).reason, "budget");
});

const FAILURE_CASES: readonly {
    readonly text: string | null;
    readonly expected: ReturnType<typeof classifyFailure>;
}[] = [
    { text: "You have hit your usage limit", expected: "usage-limit" },
    { text: "USAGE LIMIT REACHED", expected: "usage-limit" },
    { text: "Rate limit exceeded", expected: "usage-limit" },
    { text: "insufficient_quota", expected: "usage-limit" },
    { text: "429 Too Many Requests", expected: "usage-limit" },
    { text: "429", expected: "usage-limit" },
    { text: "Your credit balance is too low", expected: "usage-limit" },
    { text: "billing hard limit reached", expected: "usage-limit" },
    { text: "quota exceeded and unauthorized", expected: "usage-limit" },
    { text: "401 Unauthorized", expected: "auth" },
    { text: "invalid api key provided", expected: "auth" },
    { text: "Authentication failed", expected: "auth" },
    { text: "invalid_api_key", expected: "auth" },
    { text: "403 Forbidden", expected: "auth" },
    { text: "500 Internal Server Error", expected: "transient" },
    { text: "503 Service Unavailable", expected: "transient" },
    { text: "server overloaded", expected: "transient" },
    { text: "request timeout", expected: "transient" },
    { text: "ECONNRESET", expected: "transient" },
    { text: "ECONNREFUSED", expected: "transient" },
    { text: "socket hang up", expected: "transient" },
    { text: "network error", expected: "transient" },
    { text: null, expected: "unknown" },
    { text: "", expected: "unknown" },
    { text: "   ", expected: "unknown" },
    { text: "context length exceeded", expected: "unknown" },
];

for (const { text, expected } of FAILURE_CASES) {
    test(`classifyFailure(${JSON.stringify(text)}) is ${expected}`, () => {
        assert.equal(classifyFailure(text), expected);
    });
}
