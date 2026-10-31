import assert from "node:assert/strict";
import test from "node:test";
import {
    asCustomMessage,
    commandNamed,
    commitSentMessage,
    isRecord,
    lastSnapshot,
    makeGoalHarness,
    snapshots,
    type GoalHarness,
    type NotificationRecord,
} from "./support/fake-host.ts";

function lastNote(harness: GoalHarness): NotificationRecord {
    const note = harness.host.ui.notifications.at(-1);
    assert.ok(note !== undefined, "expected a notification");
    return note;
}

function goalCommand(harness: GoalHarness) {
    return commandNamed(harness.host, "goal");
}

async function runGoalCommand(harness: GoalHarness, args: string): Promise<void> {
    await goalCommand(harness).handler(args, harness.ctx);
}

/** Create a goal through `/goal` and model the run it starts. */
async function createGoal(harness: GoalHarness, objective = "ship the release"): Promise<void> {
    harness.session.appendUser("set a goal");
    harness.session.appendAssistant({ text: "ok" });
    await runGoalCommand(harness, objective);
    commitSentMessage(harness.session, harness.host);
}

test("/goal <objective> persists an active goal and starts a turn", async () => {
    const harness = makeGoalHarness();
    try {
        const { host, session } = harness;
        session.appendUser("do something");
        session.appendAssistant({ text: "ok" });

        await runGoalCommand(harness, "ship the release");

        const snapshot = lastSnapshot(host);
        assert.equal(snapshot.status, "active");
        assert.equal(snapshot.objective, "ship the release");
        assert.equal(snapshot.revision, 1);

        assert.equal(host.sentMessages.length, 1);
        const sent = host.sentMessages[0];
        assert.ok(sent !== undefined);
        const message = asCustomMessage(sent.message);
        assert.equal(message.customType, "goal-directive");
        assert.ok(isRecord(message.details));
        assert.equal(message.details.kind, "kickoff");
        assert.ok(isRecord(sent.options));
        assert.equal(sent.options.triggerTurn, true);

        assert.equal(lastNote(harness).type, "info");
        assert.match(lastNote(harness).message, /Goal created/);
    } finally {
        await harness.close();
    }
});

test("/goal refuses to create a goal while the agent is busy", async () => {
    const harness = makeGoalHarness();
    try {
        const { host, session } = harness;
        session.appendUser("do something");
        session.appendAssistant({ text: "ok" });
        host.setIdle(false);

        await runGoalCommand(harness, "ship the release");

        assert.deepEqual(host.appended, []);
        assert.deepEqual(host.sentMessages, []);
        assert.equal(lastNote(harness).type, "warning");
        assert.match(lastNote(harness).message, /Finish or interrupt the running turn/);
    } finally {
        await harness.close();
    }
});

test("/goal and /goal status without a goal print usage", async () => {
    const harness = makeGoalHarness();
    try {
        await runGoalCommand(harness, "");
        assert.match(lastNote(harness).message, /No goal set/);
        assert.match(lastNote(harness).message, /\/goal <objective>/);
        assert.match(lastNote(harness).message, /\/goal budget <tokens>/);

        await runGoalCommand(harness, "status");
        assert.match(lastNote(harness).message, /No goal set/);
        assert.match(lastNote(harness).message, /\/goal <objective>/);
    } finally {
        await harness.close();
    }
});

test("/goal status with a goal prints the detail lines", async () => {
    const harness = makeGoalHarness();
    try {
        await createGoal(harness, "ship the release");
        await runGoalCommand(harness, "status");

        const note = lastNote(harness);
        assert.match(note.message, /Status: active/);
        assert.match(note.message, /Objective: ship the release/);
        assert.match(note.message, /Tokens: \d+ charged/);
        assert.match(note.message, /Budget: unbounded/);
    } finally {
        await harness.close();
    }
});

test("/goal pause then /goal resume persist both states and resume starts a turn", async () => {
    const harness = makeGoalHarness();
    try {
        const { host } = harness;
        await createGoal(harness);

        await runGoalCommand(harness, "pause");
        const paused = lastSnapshot(host);
        assert.equal(paused.status, "paused");
        assert.ok(isRecord(paused.pause));
        assert.equal(paused.pause.reason, "user");
        assert.match(lastNote(harness).message, /Goal paused/);

        const sentBefore = host.sentMessages.length;
        await runGoalCommand(harness, "resume");

        const resumed = lastSnapshot(host);
        assert.equal(resumed.status, "active");
        assert.equal(resumed.pause, null);
        assert.match(lastNote(harness).message, /Goal resumed/);

        assert.equal(host.sentMessages.length, sentBefore + 1);
        const sent = host.sentMessages.at(-1);
        assert.ok(sent !== undefined);
        const message = asCustomMessage(sent.message);
        assert.equal(message.customType, "goal-directive");
        assert.ok(isRecord(message.details));
        assert.equal(message.details.kind, "continuation");
        assert.ok(isRecord(sent.options));
        assert.equal(sent.options.triggerTurn, true);
    } finally {
        await harness.close();
    }
});

test("/goal clear removes the goal through a tombstone", async () => {
    const harness = makeGoalHarness();
    try {
        const { host } = harness;
        await createGoal(harness);

        await runGoalCommand(harness, "clear");
        assert.equal(host.appended.at(-1)?.customType, "goal-cleared");
        assert.match(lastNote(harness).message, /Goal cleared/);

        await runGoalCommand(harness, "status");
        assert.match(lastNote(harness).message, /No goal set/);
        assert.match(lastNote(harness).message, /\/goal <objective>/);
    } finally {
        await harness.close();
    }
});

test("/goal budget sets, clears, and rejects invalid values", async () => {
    const harness = makeGoalHarness();
    try {
        const { host } = harness;
        await createGoal(harness);

        await runGoalCommand(harness, "budget 5000");
        assert.equal(lastSnapshot(host).budgetTokens, 5000);
        assert.match(lastNote(harness).message, /budget set to 5000 tokens/);

        await runGoalCommand(harness, "budget off");
        assert.equal(lastSnapshot(host).budgetTokens, null);
        assert.match(lastNote(harness).message, /budget removed \(unlimited\)/);

        const snapshotsBefore = snapshots(host).length;
        await runGoalCommand(harness, "budget -1");
        assert.equal(snapshots(host).length, snapshotsBefore);
        assert.equal(lastNote(harness).type, "error");
        assert.match(lastNote(harness).message, /Usage: \/goal budget/);

        await runGoalCommand(harness, "budget abc");
        assert.equal(snapshots(host).length, snapshotsBefore);
        assert.equal(lastNote(harness).type, "error");
        assert.match(lastNote(harness).message, /Usage: \/goal budget/);
    } finally {
        await harness.close();
    }
});

test("/goal history prints the persisted transitions", async () => {
    const harness = makeGoalHarness();
    try {
        await createGoal(harness);
        await runGoalCommand(harness, "pause");
        await runGoalCommand(harness, "history");

        const note = lastNote(harness);
        assert.match(note.message, /none -> active \(created\)/);
        assert.match(note.message, /active -> paused \(user\)/);
    } finally {
        await harness.close();
    }
});

test("/goal debug dumps the snapshot and derived metrics", async () => {
    const harness = makeGoalHarness();
    try {
        await createGoal(harness);
        await runGoalCommand(harness, "debug");

        const note = lastNote(harness);
        assert.match(note.message, /"status": "active"/);
        assert.match(note.message, /"revision": \d+/);
        assert.match(note.message, /"goalTurns": /);
        assert.match(note.message, /"maxGoalTurns": /);
    } finally {
        await harness.close();
    }
});

test("/goal edit uses the editor; cancelling changes nothing", async () => {
    const harness = makeGoalHarness();
    try {
        const { host, ctx } = harness;
        await createGoal(harness, "original objective");

        const before = snapshots(host).length;
        const sentBefore = host.sentMessages.length;
        await runGoalCommand(harness, "edit");

        assert.equal(snapshots(host).length, before);
        assert.equal(host.sentMessages.length, sentBefore);
        assert.equal(lastSnapshot(host).objective, "original objective");
        assert.match(lastNote(harness).message, /objective unchanged/);
        assert.equal(ctx.ui.notifications.length > 0, true);
    } finally {
        await harness.close();
    }
});

test("/goal edit persists a new objective and sends an objective-updated directive", async () => {
    const harness = makeGoalHarness();
    try {
        const { host, ctx } = harness;
        await createGoal(harness, "original objective");
        ctx.setEditorAnswer("revised objective");

        await runGoalCommand(harness, "edit");

        const snapshot = lastSnapshot(host);
        assert.equal(snapshot.objective, "revised objective");
        assert.equal(snapshot.status, "active");
        assert.match(lastNote(harness).message, /objective updated/);

        const sent = host.sentMessages.at(-1);
        assert.ok(sent !== undefined);
        const message = asCustomMessage(sent.message);
        assert.equal(message.customType, "goal-directive");
        assert.ok(isRecord(message.details));
        assert.equal(message.details.kind, "objective-updated");
        assert.ok(isRecord(sent.options));
        assert.equal(sent.options.triggerTurn, true);
    } finally {
        await harness.close();
    }
});

test("/goal with a misspelled subcommand suggests the real one", async () => {
    const harness = makeGoalHarness();
    try {
        await runGoalCommand(harness, "budgte 1000");
        assert.equal(harness.host.appended.length, 0, "no goal is created");
        assert.ok(
            harness.host.ui.notifications.some((note) =>
                note.message.includes("Did you mean /goal budget"),
            ),
        );
    } finally {
        await harness.close();
    }
});
