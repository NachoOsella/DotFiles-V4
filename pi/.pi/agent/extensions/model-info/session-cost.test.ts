import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { computeActiveBranchCost } from "./src/session-cost.ts";

function usage(total: number) {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function assistant(id: string, total: number) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2024-12-03T14:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: usage(total),
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function toolResult(id: string, total: number | undefined) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2024-12-03T14:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "output" }],
      ...(total === undefined ? {} : { usage: usage(total) }),
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function compaction(id: string, total: number | undefined, extra = {}) {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2024-12-03T14:10:00.000Z",
    summary: "summary",
    firstKeptEntryId: "x",
    tokensBefore: 1000,
    ...(total === undefined ? {} : { usage: usage(total) }),
    ...extra,
  } as unknown as SessionEntry;
}

function branchSummary(id: string, total: number | undefined) {
  return {
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: "2024-12-03T14:15:00.000Z",
    fromId: "y",
    summary: "branch explored A",
    ...(total === undefined ? {} : { usage: usage(total) }),
  } as unknown as SessionEntry;
}

describe("computeActiveBranchCost", () => {
  it("sums assistant messages on the active branch", () => {
    assert.equal(
      computeActiveBranchCost([assistant("a1", 1), assistant("a2", 2)]),
      3,
    );
  });

  it("includes tool-result usage (regression: previously omitted)", () => {
    const branch = [assistant("a1", 1), toolResult("t1", 0.5)];
    assert.equal(computeActiveBranchCost(branch), 1.5);
  });

  it("includes compaction and branch-summary usage (regression)", () => {
    const branch = [
      assistant("a1", 1),
      compaction("c1", 0.25),
      branchSummary("b1", 0.25),
    ];
    assert.equal(computeActiveBranchCost(branch), 1.5);
  });

  it("differs from the old assistant-only total on a mixed fixture", () => {
    const branch = [
      assistant("a1", 1),
      toolResult("t1", 1),
      compaction("c1", 0.25),
      branchSummary("b1", 0.25),
    ];
    const assistantOnly = branch
      .filter(
        (e): e is Extract<SessionEntry, { type: "message" }> =>
          e.type === "message" &&
          (e as { message: { role: string } }).message.role === "assistant",
      )
      .reduce(
        (sum, e) =>
          sum +
          (e.message as { usage: { cost: { total: number } } }).usage.cost
            .total,
        0,
      );
    assert.equal(assistantOnly, 1);
    assert.equal(computeActiveBranchCost(branch), 2.5);
  });

  it("does not traverse retainedTail as separately billed messages", () => {
    const retainedTail = [
      {
        role: "assistant",
        content: [{ type: "text", text: "kept reply" }],
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: usage(5),
        stopReason: "stop",
      },
    ];
    const branch = [compaction("c1", 0.5, { retainedTail })];
    assert.equal(computeActiveBranchCost(branch), 0.5);
  });

  it("counts each entry once and ignores entries without usage", () => {
    const branch = [
      assistant("a1", 1),
      toolResult("t1", undefined),
      compaction("c1", undefined),
      branchSummary("b1", undefined),
      {
        type: "user",
        id: "u1",
        parentId: null,
        timestamp: "",
      } as unknown as SessionEntry,
    ];
    assert.equal(computeActiveBranchCost(branch), 1);
  });

  it("ignores non-finite cost totals", () => {
    const branch = [
      assistant("a1", 1),
      assistant("a2", NaN),
      assistant("a3", Infinity),
    ];
    assert.equal(computeActiveBranchCost(branch), 1);
  });

  it("returns 0 for an empty branch", () => {
    assert.equal(computeActiveBranchCost([]), 0);
  });

  it("recomputes on navigation and replay (no stale cached total)", () => {
    const before = [assistant("a1", 1)];
    const afterNavigation = [assistant("a1", 1), assistant("a2", 2)];
    assert.equal(computeActiveBranchCost(before), 1);
    assert.equal(computeActiveBranchCost(afterNavigation), 3);
    // Replay with identical ids but new usage objects must not reuse totals.
    const replayed = [assistant("a1", 10)];
    assert.equal(computeActiveBranchCost(replayed), 10);
  });
});
