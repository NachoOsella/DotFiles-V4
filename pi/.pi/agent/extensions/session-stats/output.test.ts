import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { calculateAllSessionTotals, buildAllStatsOutput } from "./output.ts";
import { compactToolUsage } from "./panels.ts";
import type { SessionStats } from "./types.ts";

function session(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    file: "session.jsonl",
    startTime: "2026-01-01T10:00:00.000Z",
    durationMs: 60_000,
    totalTokens: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 25,
      totalTokens: 350,
      cost: { total: 0.1 },
    },
    userMessages: 2,
    assistantMessages: 3,
    toolResults: 4,
    customMessages: 0,
    toolCalls: [{ name: "read", count: 4 }],
    models: [],
    ...overrides,
  };
}

test("compactToolUsage limits rows and aggregates the long tail", () => {
  const compact = compactToolUsage([
    { name: "read", count: 10 },
    { name: "edit", count: 8 },
    { name: "bash", count: 6 },
    { name: "write", count: 4 },
    { name: "grep", count: 3 },
    { name: "find", count: 2 },
    { name: "ls", count: 1 },
  ]);

  assert.equal(compact.length, 5);
  assert.deepEqual(compact.at(-1), { name: "Other", count: 6 });
});

test("aggregate totals separate conversation messages from tool calls", () => {
  const totals = calculateAllSessionTotals([
    session(),
    session({ startTime: "2026-01-02T10:00:00.000Z", durationMs: 120_000 }),
  ]);

  assert.equal(totals.activeDays, 2);
  assert.equal(totals.conversationMessages, 10);
  assert.equal(totals.toolCalls, 8);
  assert.equal(totals.averageDurationMs, 90_000);
  assert.equal(totals.cacheWrite, 50);
});

test("dashboard stays within its requested width", () => {
  const output = buildAllStatsOutput([session()], undefined, 60);
  for (const line of output.split("\n")) {
    assert.ok(visibleWidth(line) <= 60, `line exceeded width: ${line}`);
  }
});
