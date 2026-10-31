import assert from "node:assert/strict";
import { test } from "node:test";
import {
    FakeSession,
    isAssistantMessageEntry,
    isCustomMessageEntry,
    type FakeEntry,
} from "./fake-session.ts";
import { driveAbortedTurn, driveErrorTurn, driveGoalTurns, type BoundaryRequest } from "./fake-boundary.ts";

function lastEntry(branch: readonly FakeEntry[]): FakeEntry {
    const entry = branch[branch.length - 1];
    if (entry === undefined) throw new Error("expected at least one entry");
    return entry;
}

test("appends form a parent chain and getBranch is root-first", () => {
    const session = new FakeSession();
    const user = session.appendUser("hello");
    const assistant = session.appendAssistant({
        text: "working",
        toolCalls: [{ id: "tc1", name: "read" }],
    });
    const tool = session.appendToolResult({ toolName: "read" });

    assert.deepEqual([user.id, assistant.id, tool.id], ["e1", "e2", "e3"]);
    assert.equal(user.parentId, null);
    assert.equal(assistant.parentId, user.id);
    assert.equal(tool.parentId, assistant.id);
    assert.equal(session.leafId, tool.id);
    assert.deepEqual(session.getBranch().map((entry) => entry.id), [user.id, assistant.id, tool.id]);
    assert.deepEqual(session.getEntries().map((entry) => entry.id), [user.id, assistant.id, tool.id]);
    assert.deepEqual(
        session.filterEntriesBy(isAssistantMessageEntry).map((entry) => entry.id),
        [assistant.id],
    );

    if (!isAssistantMessageEntry(assistant)) throw new Error("expected assistant entry");
    assert.equal(assistant.message.stopReason, "toolUse");
    assert.deepEqual(assistant.message.content, [
        { type: "text", text: "working" },
        { type: "toolCall", id: "tc1", name: "read", arguments: {} },
    ]);
});

test("rewind moves the leaf, keeps entries, and later appends form a sibling branch", () => {
    const session = new FakeSession();
    const root = session.appendUser("root");
    const firstReply = session.appendAssistant({ text: "first" });
    session.appendUser("abandoned prompt");
    session.rewindTo(firstReply.id);

    assert.equal(session.leafId, firstReply.id);
    assert.deepEqual(session.getBranch().map((entry) => entry.id), [root.id, firstReply.id]);

    const sibling = session.appendAssistant({ text: "alternate" });
    assert.equal(sibling.parentId, firstReply.id);
    assert.deepEqual(session.getBranch().map((entry) => entry.id), [root.id, firstReply.id, sibling.id]);
    assert.deepEqual(
        session.getEntries().map((entry) => entry.id),
        ["e1", "e2", "e3", "e4"],
    );

    session.rewindTo(null);
    assert.equal(session.leafId, null);
    assert.deepEqual(session.getBranch(), []);
    const freshRoot = session.appendUser("fresh");
    assert.equal(freshRoot.parentId, null);
    assert.throws(() => session.rewindTo("missing"), /not found/);
});

test("fork copies only the current branch with a new session id", () => {
    const session = new FakeSession();
    const root = session.appendUser("root");
    const kept = session.appendAssistant({ text: "kept" });
    session.appendUser("abandoned");
    session.rewindTo(kept.id);
    const tip = session.appendAssistant({ text: "tip" });

    const forked = session.fork();
    assert.equal(forked.sessionId, "fake-session-1-fork-1");
    assert.notEqual(forked.sessionId, session.sessionId);
    assert.deepEqual(forked.getBranch().map((entry) => entry.id), [root.id, kept.id, tip.id]);
    assert.deepEqual(
        forked.getBranch().map((entry) => entry.parentId),
        session.getBranch().map((entry) => entry.parentId),
    );
    assert.equal(forked.getEntries().length, 3);
    assert.equal(forked.leafId, tip.id);

    const appended = forked.appendUser("after fork");
    assert.equal(appended.id, "e5");
    assert.equal(session.getEntries().length, 4);
});

test("compaction hides summarized entries from context but not from the branch", () => {
    const session = new FakeSession();
    const snapshot = session.appendCustom("goal-snapshot", { version: 1 });
    const user = session.appendUser("goal work");
    const assistant = session.appendAssistant({ text: "step", usage: { input: 100, output: 20 } });
    const kept = session.appendUser("kept tail");
    const compaction = session.compact(kept.id);

    assert.deepEqual(
        session.getBranch().map((entry) => entry.id),
        [snapshot.id, user.id, assistant.id, kept.id, compaction.id],
    );
    assert.deepEqual(
        session.buildContextEntries().map((entry) => entry.id),
        [compaction.id, kept.id],
    );
    assert.equal(compaction.tokensBefore, 120);
    assert.ok(compaction.summary.length > 0);
    assert.equal(session.getEntries().length, 5);
});

test("a null firstKeptEntryId keeps nothing and an unknown id collapses context", () => {
    const session = new FakeSession();
    session.appendUser("one");
    const selfRetaining = session.compact(null);
    assert.equal(selfRetaining.firstKeptEntryId, selfRetaining.id);
    assert.deepEqual(session.buildContextEntries().map((entry) => entry.id), [selfRetaining.id]);

    session.appendUser("after");
    const invalid = session.compact("missing-entry");
    assert.deepEqual(session.buildContextEntries().map((entry) => entry.id), [invalid.id]);
    assert.equal(session.getBranch().length, 4);
});

test("assistant, tool, and usage entries normalize numeric usage", () => {
    const session = new FakeSession();
    const assistant = session.appendAssistant({
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 },
    });
    if (!isAssistantMessageEntry(assistant)) throw new Error("expected assistant entry");
    assert.deepEqual(assistant.message.usage, {
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 20,
        cost: { total: 0 },
    });

    const priced = session.appendAssistant({ usage: { input: 1, output: 2, cost: { total: 0.25 } } });
    if (!isAssistantMessageEntry(priced)) throw new Error("expected assistant entry");
    assert.equal(priced.message.usage.totalTokens, 3);
    assert.equal(priced.message.usage.cost?.total, 0.25);

    const tool = session.appendToolResult({ toolName: "grep", usage: { input: 7, cacheRead: 1 } });
    if (tool.message?.role !== "toolResult") throw new Error("expected tool result entry");
    assert.deepEqual(tool.message.usage, {
        input: 7,
        output: 0,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { total: 0 },
    });

    const warm = session.appendUsageEntry("cache-warm", { input: 4, cacheWrite: 1 });
    assert.equal(warm.type, "usage");
    assert.equal(warm.kind, "cache-warm");
    assert.equal(warm.usage.totalTokens, 5);
});

test("driver applies each draft, responds, and stops on the decision", () => {
    const session = new FakeSession();
    session.appendUser("implement the goal");
    const firstTry = session.appendAssistant({ text: "step 1" });
    const requests: BoundaryRequest[] = [];

    const result = driveGoalTurns(session, {
        decide: (request) => {
            requests.push(request);
            if (requests.length > 2) return { continue: false };
            return {
                continue: true,
                entries: [
                    {
                        customType: "goal-directive",
                        content: `continue ${requests.length}`,
                        display: false,
                        details: { kind: "continuation", anchorEntryId: request.assistantEntryId },
                    },
                ],
            };
        },
        respond: (turn, current) => {
            current.appendAssistant({ text: `step ${turn + 1}` });
        },
    });

    assert.deepEqual(result, { turns: 3, continuations: 2, stoppedBy: "decision" });
    const branch = session.getBranch();
    assert.deepEqual(
        branch.map((entry) => entry.type),
        ["message", "message", "custom_message", "message", "custom_message", "message"],
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.assistantEntryId, firstTry.id);
    assert.equal(requests[1]?.assistantEntryId, branch[3]?.id);
    assert.equal(requests[2]?.assistantEntryId, branch[5]?.id);

    const applied = branch.filter(isCustomMessageEntry);
    assert.deepEqual(
        applied.map((entry) => entry.content),
        ["continue 1", "continue 2"],
    );
    assert.ok(applied.every((entry) => entry.display === false));
    assert.deepEqual(
        applied.map((entry) => entry.details),
        [
            { kind: "continuation", anchorEntryId: firstTry.id },
            { kind: "continuation", anchorEntryId: branch[3]?.id },
        ],
    );
});

test("driver can reconstruct the same-boundary duplicate scenario", () => {
    const session = new FakeSession();
    session.appendUser("go");
    const assistant = session.appendAssistant({ text: "only try" });
    const anchors: (string | null)[] = [];

    const result = driveGoalTurns(session, {
        decide: (request) => {
            anchors.push(request.assistantEntryId);
            if (anchors.length > 2) return { continue: false };
            return {
                continue: true,
                entries: [
                    {
                        customType: "goal-directive",
                        content: `duplicate ${anchors.length}`,
                        display: false,
                        details: { anchorEntryId: request.assistantEntryId },
                    },
                ],
            };
        },
        respond: () => {
            // The model produced nothing new, so the next boundary sees the same assistant entry.
        },
    });

    assert.deepEqual(anchors, [assistant.id, assistant.id, assistant.id]);
    assert.deepEqual(result, { turns: 3, continuations: 2, stoppedBy: "decision" });
    const applied = session.getBranch().filter(isCustomMessageEntry);
    assert.equal(applied.length, 2);
    assert.deepEqual(
        applied.map((entry) => entry.details),
        [{ anchorEntryId: assistant.id }, { anchorEntryId: assistant.id }],
    );
});

test("maxTurns stops a plan that never stops", () => {
    const session = new FakeSession();
    session.appendUser("loop");
    session.appendAssistant({ text: "loop 1" });

    const result = driveGoalTurns(session, {
        decide: () => ({
            continue: true,
            entries: [{ customType: "goal-directive", content: "again", display: false }],
        }),
        respond: (_turn, current) => {
            current.appendAssistant({ text: "loop" });
        },
        maxTurns: 3,
    });

    assert.deepEqual(result, { turns: 3, continuations: 3, stoppedBy: "max-turns" });
    assert.equal(session.getBranch().filter(isCustomMessageEntry).length, 3);
});

test("continuing without a draft over an assistant message throws", () => {
    const session = new FakeSession();
    session.appendUser("go");
    session.appendAssistant({ text: "answer" });
    const before = session.getEntries().length;

    assert.throws(
        () => driveGoalTurns(session, { decide: () => ({ continue: true }), respond: () => {} }),
        /without runnable model context/,
    );
    assert.equal(session.getEntries().length, before);
});

test("continuing without a draft over a tool result is allowed", () => {
    const session = new FakeSession();
    session.appendUser("go");
    session.appendAssistant({ text: "calling", toolCalls: [{ id: "tc1", name: "read" }] });
    session.appendToolResult({ toolName: "read" });
    let calls = 0;

    const result = driveGoalTurns(session, {
        decide: () => {
            calls += 1;
            return calls === 1 ? { continue: true } : { continue: false };
        },
        respond: (_turn, current) => {
            current.appendAssistant({ text: "done" });
        },
    });

    assert.deepEqual(result, { turns: 2, continuations: 1, stoppedBy: "decision" });
});

test("an aborted turn appends a partial assistant message and never reaches the boundary", () => {
    const session = new FakeSession();
    session.appendUser("long task");
    const signals: number[] = [];

    const result = driveAbortedTurn(session, (current) => {
        signals.push(current.now());
    });

    assert.equal(result.boundaryInvoked, false);
    assert.equal(result.outcome, "aborted");
    assert.deepEqual(signals, [session.now()]);
    const last = lastEntry(session.getBranch());
    assert.equal(last.id, result.assistantEntryId);
    if (last.type !== "message" || last.message?.role !== "assistant") {
        throw new Error("expected assistant entry");
    }
    assert.equal(last.message.stopReason, "aborted");
    assert.equal(session.getBranch().filter(isCustomMessageEntry).length, 0);
});

test("an error turn yields a boundary request with the provider error text", () => {
    const session = new FakeSession();
    session.appendUser("go");

    const request = driveErrorTurn(session, "401 invalid api key");

    assert.equal(request.outcome, "error");
    assert.equal(request.errorText, "401 invalid api key");
    assert.equal(request.assistantEntryId, session.leafId);
    assert.equal(request.now, session.now());
    const last = lastEntry(session.getBranch());
    if (last.type !== "message" || last.message?.role !== "assistant") {
        throw new Error("expected assistant entry");
    }
    assert.equal(last.message.stopReason, "error");
    assert.equal(last.message.errorMessage, "401 invalid api key");
});

test("the clock is deterministic and entry timestamps stay ordered", () => {
    const session = new FakeSession();
    const start = session.now();
    session.advance(1500);
    assert.equal(session.now(), start + 1500);

    const user = session.appendUser("a");
    const assistant = session.appendAssistant({ text: "b" });
    assert.equal(user.timestamp, new Date(start + 1501).toISOString());
    assert.ok(Date.parse(user.timestamp) > session.now());
    assert.ok(Date.parse(assistant.timestamp) > Date.parse(user.timestamp));
    assert.throws(() => session.advance(-1), /non-negative/);
});
