import assert from "node:assert/strict";
import { test } from "node:test";
import {
    GOAL_DIRECTIVE_CUSTOM_TYPE,
    GOAL_SNAPSHOT_CUSTOM_TYPE,
    type DirectiveKind,
    type TranscriptEntry,
} from "../src/domain/goal.ts";
import {
    deriveTurnStats,
    isGoalTool,
    summarizeToolName,
} from "../src/services/progress-tracker.ts";

const GOAL = "goal-1";

function directiveEntry(
    id: string,
    goalId: string,
    kind: DirectiveKind,
    turn: number,
    anchorEntryId: string | null = null,
): TranscriptEntry {
    return {
        type: "custom_message",
        id,
        customType: GOAL_DIRECTIVE_CUSTOM_TYPE,
        details: { goalId, kind, turn, anchorEntryId },
    };
}

function toolResult(id: string, toolName: string, isError = false): TranscriptEntry {
    return { type: "message", id, message: { role: "toolResult", toolName, isError } };
}

function userEntry(id: string): TranscriptEntry {
    return { type: "message", id, message: { role: "user" } };
}

test("no directives yields zero turn stats", () => {
    const stats = deriveTurnStats([userEntry("u1"), toolResult("r1", "read")], GOAL);

    assert.deepEqual(stats, {
        goalTurns: 0,
        continuationCount: 0,
        wrapupCount: 0,
        toolCalls: 0,
        failedToolCalls: 0,
        currentTurnEvidence: 0,
        currentTurnMutated: false,
        idleTurns: 0,
        directivePending: false,
        lastDirectiveEntryId: null,
        lastDirectiveAnchorId: null,
    });
});

test("a trailing kickoff directive is pending and forms an empty turn", () => {
    const branch = [directiveEntry("d1", GOAL, "kickoff", 1, "assistant-1")];

    const stats = deriveTurnStats(branch, GOAL);
    // A directive the model never answered is not an idle turn.
    assert.equal(stats.idleTurns, 0);

    assert.equal(stats.goalTurns, 1);
    assert.equal(stats.directivePending, true);
    assert.equal(stats.currentTurnEvidence, 0);
    assert.equal(stats.currentTurnMutated, false);
    assert.equal(stats.lastDirectiveEntryId, "d1");
    assert.equal(stats.lastDirectiveAnchorId, "assistant-1");
});

test("successful non-goal tool results count as evidence and mutations", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "read"),
        toolResult("r2", "write"),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.currentTurnEvidence, 2);
    assert.equal(stats.currentTurnMutated, true);
    assert.equal(stats.toolCalls, 2);
    assert.equal(stats.failedToolCalls, 0);
    assert.equal(stats.idleTurns, 0);
    assert.equal(stats.directivePending, false);
});

test("goal tools count as tool calls but never as evidence", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "get_goal"),
        toolResult("r2", "create_goal"),
        toolResult("r3", "update_goal"),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.toolCalls, 3);
    assert.equal(stats.currentTurnEvidence, 0);
    assert.equal(stats.currentTurnMutated, false);
    assert.equal(stats.idleTurns, 1);
});

test("failed tool results count as calls but not as evidence or mutation", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "read", true),
        toolResult("r2", "edit", true),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.toolCalls, 2);
    assert.equal(stats.failedToolCalls, 2);
    assert.equal(stats.currentTurnEvidence, 0);
    assert.equal(stats.currentTurnMutated, false);
    assert.equal(stats.idleTurns, 1);
});

test("counts evidence only for the current turn", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "read"),
        directiveEntry("d2", GOAL, "continuation", 2),
        toolResult("r2", "write"),
        toolResult("r3", "read"),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.toolCalls, 3);
    assert.equal(stats.currentTurnEvidence, 2);
    assert.equal(stats.currentTurnMutated, true);
    assert.equal(stats.idleTurns, 0);
});

test("two turns with an idle second turn yield one idle turn", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "read"),
        directiveEntry("d2", GOAL, "continuation", 2),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.goalTurns, 2);
    assert.equal(stats.continuationCount, 1);
    assert.equal(stats.currentTurnEvidence, 0);
    assert.equal(stats.idleTurns, 0, "the pending turn is excluded");
    assert.equal(stats.directivePending, true);
    assert.equal(stats.lastDirectiveEntryId, "d2");
});

test("counts three trailing idle turns", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "read"),
        directiveEntry("d2", GOAL, "continuation", 2),
        directiveEntry("d3", GOAL, "continuation", 3),
        directiveEntry("d4", GOAL, "continuation", 4),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.goalTurns, 4);
    assert.equal(stats.continuationCount, 3);
    assert.equal(stats.idleTurns, 2, "the trailing pending turn is excluded");
});

test("counts every trailing idle turn instead of clamping", () => {
    const branch: TranscriptEntry[] = [directiveEntry("d0", GOAL, "kickoff", 1)];
    for (let turn = 2; turn <= 13; turn += 1) {
        branch.push(directiveEntry(`d${turn}`, GOAL, "continuation", turn));
    }

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.goalTurns, 13);
    assert.equal(stats.idleTurns, 12, "the trailing pending turn is not counted");
});

test("directive pending requires the directive to be the last branch entry", () => {
    const pending = deriveTurnStats([directiveEntry("d1", GOAL, "kickoff", 1)], GOAL);
    assert.equal(pending.directivePending, true);

    const answered = deriveTurnStats(
        [directiveEntry("d1", GOAL, "kickoff", 1), toolResult("r1", "read")],
        GOAL,
    );
    assert.equal(answered.directivePending, false);

    const trailingUser = deriveTurnStats(
        [directiveEntry("d1", GOAL, "kickoff", 1), userEntry("u1")],
        GOAL,
    );
    assert.equal(trailingUser.directivePending, false);
});

test("counts budget wrap-ups separately from continuations", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        directiveEntry("d2", GOAL, "budget-wrapup", 2),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.goalTurns, 2);
    assert.equal(stats.continuationCount, 0);
    assert.equal(stats.wrapupCount, 1);
});

test("ignores directives for other goals and malformed details", () => {
    const branch = [
        directiveEntry("other", "goal-2", "kickoff", 1),
        toolResult("r0", "read"),
        {
            type: "custom_message",
            id: "malformed",
            customType: GOAL_DIRECTIVE_CUSTOM_TYPE,
            details: { goalId: GOAL },
        },
        directiveEntry("d1", GOAL, "kickoff", 1, "assistant-1"),
        toolResult("r1", "read"),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.goalTurns, 1);
    assert.equal(stats.toolCalls, 1);
    assert.equal(stats.currentTurnEvidence, 1);
    assert.equal(stats.idleTurns, 0);
    assert.equal(stats.lastDirectiveEntryId, "d1");
    assert.equal(stats.lastDirectiveAnchorId, "assistant-1");
});

test("last directive anchor propagates from the newest matching directive", () => {
    const branch = [
        directiveEntry("d1", GOAL, "kickoff", 1, "assistant-a"),
        toolResult("r1", "read"),
        directiveEntry("d2", GOAL, "continuation", 2, "assistant-b"),
    ];

    const stats = deriveTurnStats(branch, GOAL);

    assert.equal(stats.lastDirectiveEntryId, "d2");
    assert.equal(stats.lastDirectiveAnchorId, "assistant-b");

    const withoutAnchor = deriveTurnStats([directiveEntry("d1", GOAL, "kickoff", 1)], GOAL);
    assert.equal(withoutAnchor.lastDirectiveAnchorId, null);
});

test("classifies Pi tool names into progress categories", () => {
    assert.equal(summarizeToolName("get_goal"), "goal");
    assert.equal(summarizeToolName("create_goal"), "goal");
    assert.equal(summarizeToolName("update_goal"), "goal");

    for (const name of ["read", "grep", "find", "ls"]) {
        assert.equal(summarizeToolName(name), "read");
    }
    for (const name of ["write", "edit"]) {
        assert.equal(summarizeToolName(name), "mutate");
    }
    for (const name of ["bash", "powershell"]) {
        assert.equal(summarizeToolName(name), "command");
    }
    for (const name of [undefined, "todo_write", "read_files"]) {
        assert.equal(summarizeToolName(name), "other");
        assert.equal(isGoalTool(name), false);
    }

    assert.equal(isGoalTool("get_goal"), true);
    assert.equal(isGoalTool(undefined), false);
});

test("a goal without directives starts its first turn at the creation snapshot", () => {
    const branch: TranscriptEntry[] = [
        toolResult("before", "bash"),
        {
            type: "custom",
            id: "created",
            customType: GOAL_SNAPSHOT_CUSTOM_TYPE,
            data: { goalId: GOAL },
        },
        toolResult("work", "bash"),
        toolResult("goal-call", "get_goal"),
    ];
    const stats = deriveTurnStats(branch, GOAL);
    assert.equal(stats.goalTurns, 1);
    assert.equal(stats.currentTurnEvidence, 1, "work before creation and goal tools do not count");
    assert.equal(stats.toolCalls, 2);
    assert.equal(stats.idleTurns, 0);
    assert.equal(stats.lastDirectiveEntryId, null);
    assert.equal(stats.directivePending, false);
});

test("an objective edit does not start a new goal turn", () => {
    const branch: TranscriptEntry[] = [
        directiveEntry("d1", GOAL, "kickoff", 1),
        toolResult("r1", "bash"),
        directiveEntry("d2", GOAL, "objective-updated", 2),
        toolResult("r2", "read"),
    ];
    const stats = deriveTurnStats(branch, GOAL);
    assert.equal(stats.goalTurns, 1);
    assert.equal(stats.currentTurnEvidence, 2, "the edit keeps the same turn span");
});
