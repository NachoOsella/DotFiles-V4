import assert from "node:assert/strict";
import test from "node:test";
import {
    commandNamed,
    commitSentMessage,
    isRecord,
    lastSnapshot,
    makeFakeContext,
    makeGoalHarness,
    readBoundaryResult,
    snapshots,
    type GoalHarness,
} from "./support/fake-host.ts";

/** Boundary dispatch shape the adapter reads (entries, outcome). */
function boundaryEvent(): { type: "agent_before_settle"; outcome: "completed"; entries: unknown[] } {
    return { type: "agent_before_settle", outcome: "completed", entries: [] };
}

function boundaryDispatch(harness: GoalHarness) {
    return harness.host.emit(boundaryEvent());
}

function goalIdOf(harness: GoalHarness): string {
    const goalId = lastSnapshot(harness.host).goalId;
    assert.ok(typeof goalId === "string", "snapshot must carry a goalId");
    return goalId;
}

/**
 * Create a goal through the real `/goal` command and model the run it starts:
 * the kickoff custom message becomes a branch entry, then the assistant answers.
 */
async function createActiveGoal(harness: GoalHarness): Promise<string> {
    const { host, session, ctx } = harness;
    session.appendUser("set a goal");
    session.appendAssistant({ text: "ok" });
    await commandNamed(host, "goal").handler("ship the release", ctx);
    commitSentMessage(session, host);
    return session.appendAssistant({ text: "starting" }).id;
}

test("agent_before_settle with no goal stays settled", async () => {
    const harness = makeGoalHarness();
    try {
        harness.session.appendUser("hello");
        harness.session.appendAssistant({ text: "hi" });

        assert.deepEqual(await boundaryDispatch(harness), [undefined]);
        assert.deepEqual(harness.host.appended, []);
    } finally {
        await harness.close();
    }
});

test("boundary after a goal returns one hidden continuation directive", async () => {
    const harness = makeGoalHarness();
    try {
        const assistantId = await createActiveGoal(harness);
        const goalId = goalIdOf(harness);

        const [result] = await boundaryDispatch(harness);
        const plan = readBoundaryResult(result);
        assert.equal(plan.continue, true);
        assert.equal(plan.entries.length, 1);
        const draft = plan.entries[0];
        assert.equal(draft.type, "custom_message");
        assert.equal(draft.customType, "goal-directive");
        assert.equal(draft.display, false);
        assert.ok(draft.content.length > 0);

        const details = draft.details;
        assert.ok(isRecord(details));
        assert.equal(details.goalId, goalId);
        assert.equal(details.kind, "continuation");
        assert.equal(details.turn, 2);
        assert.equal(details.anchorEntryId, assistantId);
    } finally {
        await harness.close();
    }
});

test("a second boundary anchored at the same assistant entry is deduped", async () => {
    const harness = makeGoalHarness();
    try {
        await createActiveGoal(harness);

        const [first] = await boundaryDispatch(harness);
        const plan = readBoundaryResult(first);
        assert.equal(plan.continue, true);
        const draft = plan.entries[0];
        // Pi commits the draft before the run continues; no new assistant entry.
        harness.session.appendCustomMessage(
            draft.customType,
            draft.content,
            draft.display,
            draft.details,
        );

        assert.deepEqual(await boundaryDispatch(harness), [undefined]);
    } finally {
        await harness.close();
    }
});

test("a new assistant entry lets the next boundary continue again", async () => {
    const harness = makeGoalHarness();
    try {
        await createActiveGoal(harness);

        const [first] = await boundaryDispatch(harness);
        const firstPlan = readBoundaryResult(first);
        const firstDraft = firstPlan.entries[0];
        harness.session.appendCustomMessage(
            firstDraft.customType,
            firstDraft.content,
            firstDraft.display,
            firstDraft.details,
        );
        const nextAssistant = harness.session.appendAssistant({ text: "more work" });

        const [second] = await boundaryDispatch(harness);
        const secondPlan = readBoundaryResult(second);
        assert.equal(secondPlan.continue, true);
        const details = secondPlan.entries[0].details;
        assert.ok(isRecord(details));
        assert.equal(details.kind, "continuation");
        assert.equal(details.turn, 3);
        assert.equal(details.anchorEntryId, nextAssistant.id);
    } finally {
        await harness.close();
    }
});

test("agent_settled without an aborted flag leaves an active goal untouched", async () => {
    const harness = makeGoalHarness();
    try {
        await createActiveGoal(harness);
        const before = snapshots(harness.host).length;

        assert.deepEqual(await harness.host.emit({ type: "agent_settled" }), [undefined]);

        assert.equal(snapshots(harness.host).length, before);
        assert.equal(lastSnapshot(harness.host).status, "active");
    } finally {
        await harness.close();
    }
});

test("agent_settled with aborted pauses the goal and the next boundary stays settled", async () => {
    const harness = makeGoalHarness();
    try {
        await createActiveGoal(harness);

        assert.deepEqual(
            await harness.host.emit({ type: "agent_settled", aborted: true }),
            [undefined],
        );

        const snapshot = lastSnapshot(harness.host);
        assert.equal(snapshot.status, "paused");
        assert.ok(isRecord(snapshot.pause));
        assert.equal(snapshot.pause.reason, "interrupted");
        assert.ok(
            harness.host.ui.notifications.some((note) =>
                note.message.includes("Goal paused after the interrupt"),
            ),
        );

        assert.deepEqual(await boundaryDispatch(harness), [undefined]);
    } finally {
        await harness.close();
    }
});

test("session_start on a forked session pauses the copied goal", async () => {
    const harness = makeGoalHarness();
    try {
        await createActiveGoal(harness);
        const forked = harness.session.fork();
        harness.host.setContext(makeFakeContext(forked));

        assert.deepEqual(
            await harness.host.emit({ type: "session_start", reason: "fork" }),
            [undefined],
        );

        const snapshot = lastSnapshot(harness.host);
        assert.equal(snapshot.status, "paused");
        assert.ok(isRecord(snapshot.pause));
        assert.equal(snapshot.pause.reason, "forked");
    } finally {
        await harness.close();
    }
});

test("manual compaction explains the interrupt pause instead of resuming", async () => {
    const harness = makeGoalHarness();
    try {
        await createActiveGoal(harness);
        await harness.host.emit({ type: "agent_settled", aborted: true });
        assert.equal(lastSnapshot(harness.host).status, "paused");

        const beforeManual = snapshots(harness.host).length;
        await harness.host.emit({ type: "session_before_compact", reason: "manual" });

        assert.equal(snapshots(harness.host).length, beforeManual, "no automatic resume");
        const stillPaused = lastSnapshot(harness.host);
        assert.equal(stillPaused.status, "paused");
        assert.ok(isRecord(stillPaused.pause));
        assert.equal(stillPaused.pause.reason, "interrupted");
        assert.ok(
            harness.host.ui.notifications.some((note) =>
                note.message.includes("/goal resume"),
            ),
        );

        const beforeThreshold = harness.host.appended.length;
        await harness.host.emit({ type: "session_before_compact", reason: "threshold" });
        assert.equal(harness.host.appended.length, beforeThreshold);
    } finally {
        await harness.close();
    }
});
