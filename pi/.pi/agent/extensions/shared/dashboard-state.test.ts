import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  isGitInfoState,
  isModelInfoState,
  sanitizeGitInfoState,
  sanitizeModelInfoState,
} from "./dashboard-state.ts";

describe("dashboard-state contracts", () => {
  it("still accepts legacy model-info payloads without new fields", () => {
    assert.equal(isModelInfoState(emptyModelInfoState()), true);
    assert.equal(
      isModelInfoState({
        provider: "anthropic",
        modelId: "m",
        modelName: "m",
        thinking: "off",
        contextTokens: 1,
        contextWindow: 2,
        contextPercent: 3,
        cost: 4,
        tokensPerSecond: 5,
        generating: false,
      }),
      true,
    );
  });

  it("accepts the optional throughput estimate flag and rejects mistypes", () => {
    assert.equal(
      isModelInfoState({
        ...emptyModelInfoState(),
        throughputIsEstimate: true,
      }),
      true,
    );
    assert.equal(
      isModelInfoState({
        ...emptyModelInfoState(),
        throughputIsEstimate: "yes",
      }),
      false,
    );
  });

  it("still accepts legacy git payloads without freshness fields", () => {
    assert.equal(isGitInfoState(emptyGitInfoState()), true);
  });

  it("accepts optional freshness fields and rejects mistypes", () => {
    assert.equal(isGitInfoState({ ...emptyGitInfoState(), stale: true }), true);
    assert.equal(
      isGitInfoState({
        ...emptyGitInfoState(),
        stale: true,
        refreshError: "timeout",
      }),
      true,
    );
    assert.equal(
      isGitInfoState({ ...emptyGitInfoState(), stale: "yes" }),
      false,
    );
    assert.equal(
      isGitInfoState({ ...emptyGitInfoState(), refreshError: 42 }),
      false,
    );
  });

  it("keeps accepting non-finite numbers at the contract boundary", () => {
    // Validators must not change excluded-extension contracts: NaN/Infinity
    // still validate; consumers sanitize before render.
    assert.equal(
      isModelInfoState({ ...emptyModelInfoState(), cost: NaN }),
      true,
    );
    assert.equal(
      isGitInfoState({ ...emptyGitInfoState(), changedFiles: Infinity }),
      true,
    );
  });
});

describe("dashboard-state sanitizers", () => {
  it("coerces non-finite model numerics to safe fallbacks", () => {
    const sanitized = sanitizeModelInfoState({
      ...emptyModelInfoState(),
      contextTokens: NaN,
      contextWindow: Infinity,
      contextPercent: Infinity,
      cost: NaN,
      tokensPerSecond: NaN,
    });
    assert.equal(sanitized.contextTokens, null);
    assert.equal(sanitized.contextWindow, 0);
    assert.equal(sanitized.contextPercent, null);
    assert.equal(sanitized.cost, 0);
    assert.equal(sanitized.tokensPerSecond, null);
  });

  it("preserves nulls and finite model values", () => {
    const sanitized = sanitizeModelInfoState({
      ...emptyModelInfoState(),
      contextTokens: 10,
      contextWindow: 100,
      contextPercent: 10,
      cost: 1.5,
      tokensPerSecond: 12,
    });
    assert.equal(sanitized.contextTokens, 10);
    assert.equal(sanitized.contextWindow, 100);
    assert.equal(sanitized.contextPercent, 10);
    assert.equal(sanitized.cost, 1.5);
    assert.equal(sanitized.tokensPerSecond, 12);
  });

  it("coerces non-finite or negative git change counts", () => {
    assert.equal(
      sanitizeGitInfoState({ ...emptyGitInfoState(), changedFiles: NaN })
        .changedFiles,
      0,
    );
    assert.equal(
      sanitizeGitInfoState({
        ...emptyGitInfoState(),
        changedFiles: Infinity,
      }).changedFiles,
      0,
    );
    assert.equal(
      sanitizeGitInfoState({ ...emptyGitInfoState(), changedFiles: -3 })
        .changedFiles,
      0,
    );
    assert.equal(
      sanitizeGitInfoState({ ...emptyGitInfoState(), changedFiles: 2.7 })
        .changedFiles,
      2,
    );
  });
});
