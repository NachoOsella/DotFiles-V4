import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCurrentBranch, parseSessionFile } from "./parser.ts";
import type { SessionEntryLike } from "./types.ts";

test("parseCurrentBranch aggregates safe usage, models, and tools", () => {
  const entries: SessionEntryLike[] = [
    { type: "session", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user" },
    },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "test-model",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 20,
          cacheWrite: 3,
          totalTokens: 35,
          cost: { total: 0.01 },
        },
        content: [{ type: "toolCall", name: "read" }],
      },
    },
  ];

  const stats = parseCurrentBranch(entries, "session.jsonl");

  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.durationMs, 3_000);
  assert.equal(stats.totalTokens.totalTokens, 38);
  assert.deepEqual(stats.toolCalls, [{ name: "read", count: 1 }]);
  assert.equal(stats.models[0]?.modelId, "test-model");
});

test("parseCurrentBranch estimates missing costs from model pricing", () => {
  const stats = parseCurrentBranch(
    [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "openai",
          model: "priced-model",
          usage: {
            input: 1_000_000,
            output: 2_000_000,
            cacheRead: 3_000_000,
            cacheWrite: 4_000_000,
            totalTokens: 10_000_000,
            cost: { total: 0 },
          },
        },
      },
    ],
    "ephemeral",
    undefined,
    (provider, modelId) =>
      provider === "openai" && modelId === "priced-model"
        ? { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 }
        : undefined,
  );

  assert.equal(stats.totalTokens.cost.total, 7.5);
  assert.equal(stats.models[0]?.cost, 7.5);
  assert.equal(stats.models[0]?.pricingSource, "catalog");
});

test("parseCurrentBranch marks missing model pricing as unknown", () => {
  const stats = parseCurrentBranch(
    [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "unknown-provider",
          model: "unknown-model",
          usage: {
            input: 1_000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1_500,
            cost: { total: 0 },
          },
        },
      },
    ],
    "ephemeral",
  );

  assert.equal(stats.models[0]?.pricingSource, "unknown");
});

test("parseCurrentBranch includes nested tool and compaction usage", () => {
  const stats = parseCurrentBranch(
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 20,
            cacheWrite: 2,
            totalTokens: 35,
            cost: { total: 0.02 },
          },
        },
      },
      {
        type: "compaction",
        usage: {
          input: 4,
          output: 3,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 9,
          cost: { total: 0.01 },
        },
      },
      { type: "custom_message" },
    ],
    "ephemeral",
  );

  assert.equal(stats.toolResults, 1);
  assert.equal(stats.customMessages, 1);
  assert.equal(stats.totalTokens.totalTokens, 47);
  assert.equal(stats.totalTokens.cacheWrite, 3);
  assert.equal(stats.totalTokens.cost.total, 0.03);
});

test("parseSessionFile counts billed usage across all branches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-stats-"));
  const file = join(directory, "session.jsonl");
  const entries = [
    { type: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z" },
    {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user" },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "root",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "old",
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 1 } },
      },
    },
    {
      type: "message",
      id: "active",
      parentId: "root",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "current",
        usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.1 } },
      },
    },
  ];

  try {
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const stats = await parseSessionFile(file);

    assert.equal(stats.assistantMessages, 2);
    assert.equal(stats.totalTokens.totalTokens, 165);
    assert.equal(stats.totalTokens.cost.total, 1.1);
    assert.deepEqual(
      stats.models.map((model) => model.modelId),
      ["old", "current"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parseCurrentBranch attributes usage to the concrete response model", () => {
  const resolutions: string[] = [];
  const stats = parseCurrentBranch(
    [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "gateway",
          model: "routed-alias",
          responseModel: "concrete-model",
          usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
        },
      },
    ],
    "ephemeral",
    undefined,
    (provider, modelId) => {
      resolutions.push(`${provider}/${modelId}`);
      return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    },
  );

  assert.deepEqual(resolutions, ["gateway/concrete-model"]);
  assert.equal(stats.models[0]?.modelId, "concrete-model");
});

test("parseCurrentBranch ignores malformed usage fields", () => {
  const stats = parseCurrentBranch(
    [{ type: "message", message: { role: "assistant", usage: { input: "invalid" } } }],
    "ephemeral",
  );

  assert.equal(stats.totalTokens.input, 0);
  assert.equal(stats.totalTokens.totalTokens, 0);
});
