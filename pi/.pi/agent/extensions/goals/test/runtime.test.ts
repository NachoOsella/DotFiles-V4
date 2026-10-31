/**
 * Runtime unit tests: run timing, interrupt correlation, configuration, and
 * shutdown idempotency. These are the pieces that do not depend on the engine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalRuntime, loadGoalsConfig } from "../src/runtime.ts";
import { makeFakeHost } from "./support/fake-host.ts";

function makeRuntime(env: Record<string, string | undefined> = {}) {
    const host = makeFakeHost();
    const runtime = new GoalRuntime(host.api, loadGoalsConfig(env));
    return { host, runtime };
}

test("active time accumulates across continuations in one run", () => {
    const { runtime } = makeRuntime();
    runtime.beginRun(1_000);
    runtime.beginRun(3_000);
    assert.equal(runtime.endRun(5_000), 4_000, "the first start is not reset by a continuation");
    assert.equal(runtime.endRun(9_000), 0, "ending twice yields no time");
});

test("a new run after settlement starts a fresh span", () => {
    const { runtime } = makeRuntime();
    runtime.beginRun(1_000);
    assert.equal(runtime.endRun(2_000), 1_000);
    runtime.beginRun(10_000);
    assert.equal(runtime.endRun(11_500), 1_500);
});

test("endRun without beginRun is zero", () => {
    const { runtime } = makeRuntime();
    assert.equal(runtime.endRun(5_000), 0);
});

test("interrupt correlation uses the configured window", () => {
    const { runtime } = makeRuntime();
    assert.equal(runtime.hasRecentInterrupt(1_000), false);
    runtime.markInterrupt(10_000);
    assert.equal(runtime.hasRecentInterrupt(11_000), true);
    assert.equal(runtime.hasRecentInterrupt(11_500), true, "window boundary is inclusive");
    assert.equal(runtime.hasRecentInterrupt(11_501), false);
    runtime.clearInterrupt();
    assert.equal(runtime.hasRecentInterrupt(10_100), false);
});

test("config parses environment values and falls back on invalid input", () => {
    assert.deepEqual(loadGoalsConfig({}), {
        maxGoalTurns: 200,
        maxIdleTurns: 3,
        showDirectives: false,
        defaultBudgetTokens: null,
        maxBudgetTokens: 2_000_000,
        allowUnattendedCreate: false,
    });
    assert.deepEqual(
        loadGoalsConfig({
            PI_GOAL_MAX_TURNS: "7",
            PI_GOAL_MAX_IDLE_TURNS: "9",
            PI_GOAL_SHOW_DIRECTIVES: "1",
        }),
        {
            maxGoalTurns: 7,
            maxIdleTurns: 9,
            showDirectives: true,
            defaultBudgetTokens: null,
            maxBudgetTokens: 2_000_000,
            allowUnattendedCreate: false,
        },
    );
    assert.deepEqual(loadGoalsConfig({ PI_GOAL_MAX_TURNS: "0", PI_GOAL_MAX_IDLE_TURNS: "-2" }), {
        maxGoalTurns: 200,
        maxIdleTurns: 3,
        showDirectives: false,
        defaultBudgetTokens: null,
        maxBudgetTokens: 2_000_000,
        allowUnattendedCreate: false,
    });
    assert.deepEqual(loadGoalsConfig({ PI_GOAL_MAX_TURNS: "abc" }).maxGoalTurns, 200);
});

test("dispose is idempotent", async () => {
    const { runtime } = makeRuntime();
    await runtime.dispose();
    await runtime.dispose();
});
