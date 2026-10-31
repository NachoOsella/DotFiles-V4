import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
    isRecord,
    lastSnapshot,
    makeGoalHarness,
    readBoundaryResult,
    resultText,
    structuredContentOf,
    toolNamed,
    type CustomMessageLike,
    type GoalHarness,
} from "./support/fake-host.ts";

const PAYLOAD_KEYS = ["completionBudgetReport", "goal", "remainingTokens"];

async function callTool(
    harness: GoalHarness,
    name: string,
    params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
    return toolNamed(harness.host, name).execute(
        "call-1",
        params,
        undefined,
        undefined,
        harness.ctx,
    );
}

function assertPayloadKeys(payload: Record<string, unknown>): void {
    assert.deepEqual(Object.keys(payload).sort(), PAYLOAD_KEYS);
}

/** Evaluate one boundary and commit the directive it returns, like Pi does. */
async function nextDirective(harness: GoalHarness): Promise<CustomMessageLike> {
    const [result] = await harness.host.emit({
        type: "agent_before_settle",
        outcome: "completed",
        entries: [],
    });
    const plan = readBoundaryResult(result);
    assert.equal(plan.continue, true);
    const directive = plan.entries[0];
    assert.ok(directive !== undefined, "expected a continuation directive");
    harness.session.appendCustomMessage(
        directive.customType,
        directive.content,
        directive.display,
        directive.details,
    );
    return directive;
}

/** Start one model turn: the goal directive plus the assistant response. */
async function driveGoalTurn(harness: GoalHarness, withEvidence = false): Promise<void> {
    await nextDirective(harness);
    harness.session.appendAssistant({ text: "working" });
    if (withEvidence) harness.session.appendToolResult({ toolName: "bash" });
}

test("get_goal reports a null goal before any goal exists", async () => {
    const harness = makeGoalHarness();
    try {
        const result = await callTool(harness, "get_goal", {});
        assert.notEqual(result.isError, true);
        const payload = structuredContentOf(result);
        assertPayloadKeys(payload);
        assert.equal(payload.goal, null);
        assert.equal(payload.remainingTokens, null);
        assert.equal(payload.completionBudgetReport, null);
    } finally {
        await harness.close();
    }
});

test("create_goal creates an active goal and get_goal reports it", async () => {
    const harness = makeGoalHarness();
    try {
        const created = await callTool(harness, "create_goal", { objective: "Ship the release" });
        assert.notEqual(created.isError, true);
        const createdPayload = structuredContentOf(created);
        assertPayloadKeys(createdPayload);
        assert.ok(isRecord(createdPayload.goal));
        assert.equal(createdPayload.goal.status, "active");
        assert.equal(createdPayload.goal.objective, "Ship the release");
        assert.equal(createdPayload.remainingTokens, null);
        assert.equal(createdPayload.completionBudgetReport, null);
        assert.equal(lastSnapshot(harness.host).status, "active");

        const fetched = await callTool(harness, "get_goal", {});
        const fetchedPayload = structuredContentOf(fetched);
        assert.ok(isRecord(fetchedPayload.goal));
        assert.equal(fetchedPayload.goal.status, "active");
        assert.equal(fetchedPayload.goal.goalId, createdPayload.goal.goalId);
    } finally {
        await harness.close();
    }
});

test("create_goal refuses while an unfinished goal exists", async () => {
    const harness = makeGoalHarness();
    try {
        const first = await callTool(harness, "create_goal", { objective: "First" });
        assert.notEqual(first.isError, true);

        const second = await callTool(harness, "create_goal", { objective: "Second" });
        assert.equal(second.isError, true);
        assert.match(resultText(second), /unfinished goal/);
        assert.equal(lastSnapshot(harness.host).objective, "First");
    } finally {
        await harness.close();
    }
});

test("update_goal complete requires evidence from the current goal turn", async () => {
    const harness = makeGoalHarness();
    try {
        await callTool(harness, "create_goal", { objective: "Ship the release" });

        const rejected = await callTool(harness, "update_goal", { status: "complete" });
        assert.equal(rejected.isError, true);
        const text = resultText(rejected);
        assert.match(text, /requires evidence from the current goal turn/);
        assert.match(text, /Verify the objective with real commands/);
        assert.equal(lastSnapshot(harness.host).status, "active");

        await driveGoalTurn(harness, true);
        const completed = await callTool(harness, "update_goal", { status: "complete" });
        assert.notEqual(completed.isError, true);
        const payload = structuredContentOf(completed);
        assertPayloadKeys(payload);
        assert.ok(isRecord(payload.goal));
        assert.equal(payload.goal.status, "complete");
        assert.equal(payload.completionBudgetReport, null, "Codex omits the report without a budget or elapsed time");
        assert.equal(lastSnapshot(harness.host).status, "complete");
    } finally {
        await harness.close();
    }
});

test("update_goal blocked requires three goal turns before it is accepted", async () => {
    const harness = makeGoalHarness();
    try {
        await callTool(harness, "create_goal", { objective: "Reach the gated endpoint" });

        const rejected = await callTool(harness, "update_goal", {
            status: "blocked",
            reason: "no network access",
        });
        assert.equal(rejected.isError, true);
        assert.match(resultText(rejected), /at least 3 consecutive goal turns/);
        assert.equal(lastSnapshot(harness.host).status, "active");

        await driveGoalTurn(harness);
        await driveGoalTurn(harness);
        await driveGoalTurn(harness);

        const blocked = await callTool(harness, "update_goal", {
            status: "blocked",
            reason: "no network access",
            evidence: ["curl returns ECONNREFUSED"],
        });
        assert.notEqual(blocked.isError, true);
        assert.match(resultText(blocked), /Goal marked blocked/);
        const snapshot = lastSnapshot(harness.host);
        assert.equal(snapshot.status, "blocked");
        assert.ok(isRecord(snapshot.block));
        assert.equal(snapshot.block.reason, "no network access");
    } finally {
        await harness.close();
    }
});

test("update_goal paused needs the user confirmation and keeps the goal active when denied", async () => {
    const harness = makeGoalHarness();
    try {
        await callTool(harness, "create_goal", { objective: "Ship the release" });
        harness.host.setConfirmAnswer(false);

        const denied = await callTool(harness, "update_goal", { status: "paused" });
        assert.equal(denied.isError, true);
        assert.match(resultText(denied), /Pause rejected/);
        assert.match(resultText(denied), /not authorized by the user/);
        assert.equal(lastSnapshot(harness.host).status, "active");

        harness.host.setConfirmAnswer(true);
        const paused = await callTool(harness, "update_goal", {
            status: "paused",
            reason: "user asked to stop",
        });
        assert.notEqual(paused.isError, true);
        const payload = structuredContentOf(paused);
        assert.ok(isRecord(payload.goal));
        assert.equal(payload.goal.status, "paused");
        const snapshot = lastSnapshot(harness.host);
        assert.equal(snapshot.status, "paused");
        assert.ok(isRecord(snapshot.pause));
        assert.equal(snapshot.pause.reason, "user");
    } finally {
        await harness.close();
    }
});

test("all goal tools declare an output schema and return the payload keys", async () => {
    const harness = makeGoalHarness();
    try {
        assert.equal(harness.host.tools.size, 3);
        for (const name of ["get_goal", "create_goal", "update_goal"]) {
            const tool = toolNamed(harness.host, name);
            assert.notEqual(tool.outputSchema, undefined, `${name} declares outputSchema`);
        }

        const created = await callTool(harness, "create_goal", { objective: "Ship it" });
        assertPayloadKeys(structuredContentOf(created));
        const fetched = await callTool(harness, "get_goal", {});
        assertPayloadKeys(structuredContentOf(fetched));
    } finally {
        await harness.close();
    }
});

test("create_goal requires user authorization in an interactive session", async () => {
    const harness = makeGoalHarness({ context: { confirm: false } });
    try {
        const denied = await callTool(harness, "create_goal", { objective: "Unrequested" });
        assert.equal(denied.isError, true);
        assert.match(resultText(denied), /not authorized/i);
        assert.equal(
            harness.session.getBranch().filter((entry) => entry.type === "custom").length,
            0,
        );
    } finally {
        await harness.close();
    }
});

test("create_goal is refused without UI unless unattended creation is enabled", async () => {
    const harness = makeGoalHarness({ context: { hasUI: false } });
    try {
        const refused = await callTool(harness, "create_goal", { objective: "Unrequested" });
        assert.equal(refused.isError, true);
        assert.match(resultText(refused), /not authorized/i);
    } finally {
        await harness.close();
    }
});

test("create_goal rejects a budget above the configured maximum", async () => {
    const harness = makeGoalHarness({ context: { confirm: true } });
    try {
        const rejected = await callTool(harness, "create_goal", {
            objective: "Too expensive",
            token_budget: 99_000_000,
        });
        assert.equal(rejected.isError, true);
        assert.match(resultText(rejected), /exceeds the maximum allowed/i);
    } finally {
        await harness.close();
    }
});
