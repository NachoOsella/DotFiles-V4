import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit, Option } from "effect";
import { GoalPersistenceError } from "../src/domain/errors.ts";
import {
    GOAL_SNAPSHOT_CUSTOM_TYPE,
    GOAL_SNAPSHOT_VERSION,
    type GoalSnapshot,
    type TranscriptEntry,
} from "../src/domain/goal.ts";
import {
    loadLatestSnapshot,
    persistSnapshot,
} from "../src/services/goal-repository.ts";

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    return {
        version: GOAL_SNAPSHOT_VERSION,
        goalId: "goal-1",
        sessionId: "session-1",
        revision: 1,
        status: "active",
        objective: "Ship the repository",
        budgetTokens: null,
        usageStartEntryId: null,
        createdAt: 1_000,
        updatedAt: 1_000,
        statusChangedAt: 1_000,
        activeMs: 0,
        turnBaseline: 0,
        pause: null,
        block: null,
        completion: { attempts: 0, lastRequestedAt: null, verifiedAt: null },
        history: [],
        ...overrides,
    };
}

function entry(id: string, data: unknown): TranscriptEntry {
    return { type: "custom", id, customType: GOAL_SNAPSHOT_CUSTOM_TYPE, data };
}

test("loads the newest valid snapshot and ignores older ones", () => {
    const older = snapshot({ revision: 1, goalId: "goal-old" });
    const newer = snapshot({ revision: 2, goalId: "goal-new" });
    const result = loadLatestSnapshot([
        { type: "message", id: "m1" },
        entry("snapshot-1", older),
        entry("snapshot-2", newer),
        { type: "message", id: "m2" },
    ]);
    assert.equal(result.entryId, "snapshot-2");
    assert.deepEqual(result.snapshot, newer);
    assert.deepEqual(result.issues, []);
});

test("skips a corrupt newest entry and keeps the previous snapshot", () => {
    const valid = snapshot({ revision: 7 });
    const result = loadLatestSnapshot([
        entry("snapshot-1", valid),
        entry("snapshot-2", { version: GOAL_SNAPSHOT_VERSION, goalId: 7 }),
    ]);
    assert.equal(result.entryId, "snapshot-1");
    assert.deepEqual(result.snapshot, valid);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0];
    if (issue.kind !== "corrupt") {
        throw new Error(`expected a corrupt issue, got ${issue.kind}`);
    }
    assert.equal(issue.entryId, "snapshot-2");
    assert.match(issue.message, /Expected/);
});

test("reports an unknown version as unsupported instead of corrupt", () => {
    const future: Record<string, unknown> = {
        ...snapshot(),
        version: GOAL_SNAPSHOT_VERSION + 1,
    };
    const result = loadLatestSnapshot([entry("snapshot-1", future)]);
    assert.equal(result.snapshot, null);
    assert.equal(result.entryId, null);
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0];
    if (issue.kind !== "unsupported-version") {
        throw new Error(`expected an unsupported-version issue, got ${issue.kind}`);
    }
    assert.equal(issue.version, GOAL_SNAPSHOT_VERSION + 1);
    assert.equal(issue.entryId, "snapshot-1");
});

test("parses string-encoded data and flags invalid JSON as corrupt", () => {
    const valid = snapshot({ revision: 4 });
    const fromString = loadLatestSnapshot([
        entry("snapshot-1", JSON.stringify(valid)),
    ]);
    assert.equal(fromString.entryId, "snapshot-1");
    assert.deepEqual(fromString.snapshot, valid);

    const invalidJson = loadLatestSnapshot([entry("snapshot-2", "{not json")]);
    assert.equal(invalidJson.snapshot, null);
    const invalidIssue = invalidJson.issues[0];
    if (invalidIssue.kind !== "corrupt") {
        throw new Error(`expected a corrupt issue, got ${invalidIssue.kind}`);
    }
    assert.match(invalidIssue.message, /JSON/);

    const missingData = loadLatestSnapshot([entry("snapshot-3", null)]);
    assert.equal(missingData.snapshot, null);
    assert.equal(missingData.issues[0].kind, "corrupt");
});

test("ignores other custom types and plain messages", () => {
    const result = loadLatestSnapshot([
        { type: "message", id: "m1" },
        { type: "custom", id: "c1", customType: "other", data: snapshot() },
        { type: "custom", id: "c2", data: snapshot() },
    ]);
    assert.equal(result.snapshot, null);
    assert.equal(result.entryId, null);
    assert.deepEqual(result.issues, []);
});

test("bounds load issues to three, newest first", () => {
    const valid = snapshot({ revision: 1 });
    const branch: TranscriptEntry[] = [entry("snapshot-valid", valid)];
    for (let index = 1; index <= 5; index += 1) {
        branch.push(
            entry(`snapshot-corrupt-${index}`, {
                version: GOAL_SNAPSHOT_VERSION + index,
            }),
        );
    }
    const result = loadLatestSnapshot(branch);
    assert.equal(result.entryId, "snapshot-valid");
    assert.deepEqual(result.snapshot, valid);
    assert.deepEqual(
        result.issues.map((issue) => issue.entryId),
        ["snapshot-corrupt-5", "snapshot-corrupt-4", "snapshot-corrupt-3"],
    );
});

test("persistSnapshot writes through the supplied writer", () => {
    const written: Array<{ customType: string; data: unknown }> = [];
    const value = snapshot();
    Effect.runSync(
        persistSnapshot((customType, data) => {
            written.push({ customType, data });
        }, value),
    );
    assert.deepEqual(written, [{ customType: GOAL_SNAPSHOT_CUSTOM_TYPE, data: value }]);
});

test("append failures surface as GoalPersistenceError", async () => {
    const exit = await Effect.runPromiseExit(
        persistSnapshot(() => {
            throw new Error("session file is read-only");
        }, snapshot()),
    );
    assert.equal(exit._tag, "Failure");
    const failure = Exit.findErrorOption(exit);
    if (Option.isNone(failure)) {
        throw new Error("expected the append effect to fail");
    }
    assert.ok(failure.value instanceof GoalPersistenceError);
    assert.equal(failure.value._tag, "GoalPersistenceError");
    assert.match(failure.value.message, /persist/i);
    assert.match(failure.value.detail ?? "", /read-only/);
});
