import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mergeSessionStats } from "./aggregate.ts";
import { fmtCost } from "./format.ts";
import {
  buildAllStatsOutput,
  buildProjectStatsOutput,
  buildProjectSummaries,
  calculateAllSessionTotals,
} from "./output.ts";
import { buildModelRows, compactToolUsage } from "./panels.ts";
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

test("fmtCost does not hide small non-zero estimates", () => {
  assert.equal(fmtCost(0.00001), "$0.000010");
  assert.equal(fmtCost(0.0000001), "<$0.000001");
});

test("model rows distinguish unknown pricing from free pricing", () => {
  const rows = buildModelRows(
    [
      {
        provider: "unknown",
        modelId: "unknown-model",
        messages: 1,
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        pricingSource: "unknown",
      },
      {
        provider: "free",
        modelId: "free-model",
        messages: 1,
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        pricingSource: "catalog",
      },
    ],
    80,
  );

  assert.ok(rows.some((row) => row.includes("?")));
  assert.ok(rows.some((row) => row.includes("$0")));
});

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

test("mergeSessionStats combines the parent session and subagents", () => {
  const merged = mergeSessionStats(
    [
      session({
        startTime: "2026-01-01T10:00:00.000Z",
        durationMs: 60_000,
        models: [
          {
            provider: "openai",
            modelId: "test-model",
            count: 1,
            input: 100,
            output: 50,
            cacheRead: 20,
            cacheWrite: 0,
            cost: 0.1,
          },
        ],
      }),
      session({
        startTime: "2026-01-01T10:00:30.000Z",
        durationMs: 120_000,
        userMessages: 1,
        assistantMessages: 1,
        totalTokens: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: { total: 0.02 },
        },
        models: [
          {
            provider: "openai",
            modelId: "test-model",
            count: 2,
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            cost: 0.02,
          },
        ],
      }),
    ],
    "merged.jsonl",
  );

  assert.equal(merged.userMessages, 3);
  assert.equal(merged.assistantMessages, 4);
  assert.equal(merged.totalTokens.totalTokens, 368);
  assert.equal(merged.durationMs, 150_000);
  assert.deepEqual(merged.toolCalls, [{ name: "read", count: 8 }]);
  assert.equal(merged.models[0]?.count, 3);
});

test("project summaries group sessions and sort by cost", () => {
  const base = session().totalTokens;
  const projects = buildProjectSummaries(
    [
      session({ project: "/work/alpha", totalTokens: { ...base, cost: { total: 0.1 } } }),
      session({ project: "/work/beta", totalTokens: { ...base, cost: { total: 0.2 } } }),
      session({ project: "/work/alpha", totalTokens: { ...base, cost: { total: 0.3 } } }),
    ],
    undefined,
  );

  assert.deepEqual(projects.map((project) => project.project), ["/work/alpha", "/work/beta"]);
  assert.equal(projects[0]?.sessions.length, 2);
  assert.ok(
    buildProjectStatsOutput(
      projects.flatMap((project) => project.sessions),
      undefined,
      60,
    ).includes("TOP 3 BY ESTIMATED COST"),
  );
});

test("dashboard labels the current-project filter", () => {
  const output = buildAllStatsOutput([session()], undefined, 60, undefined, true);
  assert.ok(output.includes("current project"));
});

test("dashboard stays within its requested width", () => {
  const output = buildAllStatsOutput([session()], undefined, 60);
  for (const line of output.split("\n")) {
    assert.ok(visibleWidth(line) <= 60, `line exceeded width: ${line}`);
  }
});
