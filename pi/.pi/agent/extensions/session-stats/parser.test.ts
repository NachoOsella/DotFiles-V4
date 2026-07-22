import assert from "node:assert/strict";
import test from "node:test";
import { parseCurrentBranch } from "./parser.ts";
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
  assert.equal(stats.totalTokens.totalTokens, 35);
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

test("parseCurrentBranch ignores malformed usage fields", () => {
  const stats = parseCurrentBranch(
    [{ type: "message", message: { role: "assistant", usage: { input: "invalid" } } }],
    "ephemeral",
  );

  assert.equal(stats.totalTokens.input, 0);
  assert.equal(stats.totalTokens.totalTokens, 0);
});
