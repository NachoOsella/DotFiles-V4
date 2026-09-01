import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mergeSessionStats } from "./aggregate.ts";
import { calculateCacheReadShare, fmtCost } from "./format.ts";
import {
  buildAllStatsOutput,
  buildCurrentSessionOutput,
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

test("cache read share includes newly written prompt tokens", () => {
  assert.equal(calculateCacheReadShare(100, 200, 25), (200 / 325) * 100);
});

test("model rows omit unknown and zero costs", () => {
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

  assert.ok(rows.some((row) => row.includes("unknown/unknown-model")));
  assert.ok(rows.some((row) => row.includes("free/free-model")));
  assert.ok(!rows.some((row) => row.includes("?")));
  assert.ok(!rows.some((row) => row.includes("$0")));
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
  assert.equal(totals.totalTokens, 750);
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
  assert.equal(merged.totalTokens.totalTokens, 393);
  assert.equal(merged.durationMs, 150_000);
  assert.deepEqual(merged.toolCalls, [{ name: "read", count: 8 }]);
  assert.equal(merged.models[0]?.count, 3);
});

test("current dashboard separates main-thread and subagent usage", () => {
  const mainThread = session();
  const agent = session({
    totalTokens: {
      input: 40,
      output: 20,
      cacheRead: 80,
      cacheWrite: 10,
      totalTokens: 150,
      cost: { total: 0.04 },
    },
    userMessages: 1,
    assistantMessages: 2,
  });
  const output = buildCurrentSessionOutput(
    mergeSessionStats([mainThread, agent], "merged.jsonl"),
    60,
    undefined,
    { mainThread, subagents: [agent] },
  );

  assert.ok(output.includes("THREADS"));
  assert.ok(output.includes("Main thread"));
  assert.ok(output.includes("Subagents (1)"));
  for (const line of output.split("\n")) {
    assert.ok(visibleWidth(line) <= 60, `line exceeded width: ${line}`);
  }
});

test("project summaries group sessions and sort by cost", () => {
  const base = session().totalTokens;
  const projects = buildProjectSummaries(
    [
      session({
        project: "/work/alpha",
        totalTokens: { ...base, cost: { total: 0.1 } },
      }),
      session({
        project: "/work/beta",
        totalTokens: { ...base, cost: { total: 0.2 } },
      }),
      session({
        project: "/work/alpha",
        totalTokens: { ...base, cost: { total: 0.3 } },
      }),
    ],
    undefined,
  );

  assert.deepEqual(
    projects.map((project) => project.project),
    ["/work/alpha", "/work/beta"],
  );
  assert.equal(projects[0]?.sessions.length, 2);
  assert.ok(
    buildProjectStatsOutput(
      projects.flatMap((project) => project.sessions),
      undefined,
      60,
    ).includes("TOP 3 BY KNOWN COST"),
  );
});

test("aggregate sessions count roots separately from subagent runs", () => {
  const root = session({
    totalTokens: { ...session().totalTokens, totalTokens: 350 },
  });
  const child = session({
    parentSessionPath: root.file,
    totalTokens: {
      input: 10,
      output: 5,
      cacheRead: 20,
      cacheWrite: 3,
      totalTokens: 38,
      cost: { total: 0.02 },
    },
  });

  const totals = calculateAllSessionTotals([root, child]);

  assert.equal(totals.rootSessionCount, 1);
  assert.equal(totals.subagentRuns, 1);
  assert.equal(totals.totalTokens, 413);
  assert.equal(totals.medianTokens, 375);
  assert.equal(totals.averageTokensPerSession, 413);
});

test("model rows include unattributed usage for reconciliation", () => {
  const main = session({
    totalTokens: {
      input: 120,
      output: 60,
      cacheRead: 30,
      cacheWrite: 10,
      totalTokens: 220,
      cost: {
        total: 0.15,
        reported: 0.1,
        catalog: 0.05,
        pricedTokens: 220,
      },
    },
    models: [
      {
        provider: "openai",
        modelId: "model",
        count: 1,
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 10,
        cost: 0.1,
        reportedCost: 0.1,
        catalogCost: 0,
        estimatedCost: 0,
        unknownTokens: 0,
        pricedTokens: 180,
      },
    ],
  });

  const output = buildCurrentSessionOutput(main, 60);
  assert.ok(output.includes("Tools & summaries"));
  assert.ok(output.includes("  —"));
  assert.ok(output.includes("40"));
});

test("aggregate cost totals preserve actual and estimated categories", () => {
  const totals = calculateAllSessionTotals([
    session({
      totalTokens: {
        input: 50,
        output: 25,
        cacheRead: 20,
        cacheWrite: 5,
        totalTokens: 100,
        cost: {
          total: 1.5,
          reported: 1,
          catalog: 0.5,
          estimated: 2,
          unknownTokens: 10,
          pricedTokens: 90,
        },
      },
    }),
  ]);

  assert.equal(totals.totalCost, 1.5);
  assert.equal(totals.reportedCost, 1);
  assert.equal(totals.catalogCost, 0.5);
  assert.equal(totals.estimatedCost, 2);
  assert.equal(totals.unknownPricingPercent, 10);
  assert.equal(totals.totalTokens, 100);
});

test("dashboard labels the current-project filter", () => {
  const output = buildAllStatsOutput(
    [session()],
    undefined,
    60,
    undefined,
    true,
  );
  assert.ok(output.includes("current project"));
});

test("current dashboard renders API context usage without calling it cumulative usage", () => {
  const output = buildCurrentSessionOutput(session(), 60, undefined, {
    mainThread: session(),
    subagents: [],
    contextUsage: { tokens: 72_400, contextWindow: 200_000, percent: 36.2 },
  });

  assert.ok(output.includes("Context"));
  assert.ok(output.includes("72.4K / 200K"));
  assert.ok(output.includes("36%"));
  assert.ok(output.includes("Cumulative usage"));
  assert.ok(!output.includes("Cache hit"));
});

test("current dashboard omits context when Pi does not provide it", () => {
  const output = buildCurrentSessionOutput(session(), 60);
  assert.ok(!output.includes("Context"));

  const unknownOutput = buildCurrentSessionOutput(session(), 60, undefined, {
    mainThread: session(),
    subagents: [],
    contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
  });
  assert.ok(!unknownOutput.includes("Context"));
});

test("aggregate dashboard reports parse coverage and cost quality", () => {
  const output = buildAllStatsOutput(
    [
      session({
        totalTokens: {
          ...session().totalTokens,
          cost: {
            total: 0.3,
            reported: 0.1,
            catalog: 0.2,
            estimated: 0.3,
            unknownTokens: 10,
            pricedTokens: 365,
          },
        },
      }),
    ],
    undefined,
    60,
    undefined,
    false,
    undefined,
    { parsedSessions: 2, discoveredSessions: 3 },
  );

  assert.ok(output.includes("Data: 2/3 sessions parsed"));
  assert.ok(output.includes("Reported / billed"));
  assert.ok(output.includes("Calculated catalog"));
  assert.ok(output.includes("Estimated value"));
  assert.ok(output.includes("Pricing coverage"));
  assert.ok(!output.includes("Unknown pricing"));
});

test("dashboards omit zero-only sections and values", () => {
  const empty = session({
    durationMs: 0,
    totalTokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { total: 0, unknownTokens: 0, pricedTokens: 0 },
    },
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    customMessages: 0,
    toolCalls: [],
    models: [
      {
        provider: "test",
        modelId: "unused",
        count: 1,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        pricingSource: "unknown",
      },
    ],
  });
  const output = buildCurrentSessionOutput(empty, 60);
  assert.ok(!output.includes("MODELS"));
  assert.ok(!output.includes("TOOLS"));
  assert.ok(!output.includes("$0"));
  assert.ok(!output.toLowerCase().includes("unknown"));

  const aggregateOutput = buildAllStatsOutput([empty], undefined, 60);
  assert.ok(!aggregateOutput.includes("MODELS"));
  assert.ok(!aggregateOutput.includes("TOOLS"));
  assert.ok(!aggregateOutput.includes("$0"));
  assert.ok(!aggregateOutput.toLowerCase().includes("unknown"));
});

test("dashboard stays within narrow terminal widths", () => {
  for (const width of [40, 32]) {
    const output = buildAllStatsOutput([session()], undefined, width);
    for (const line of output.split("\n")) {
      assert.ok(
        visibleWidth(line) <= width,
        `line exceeded width ${width}: ${line}`,
      );
    }
  }
});
