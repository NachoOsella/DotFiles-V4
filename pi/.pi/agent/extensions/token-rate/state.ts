import { getEffectiveTokens } from "./tokens.js";
import type { RateAssistantMessage, TokenRateState } from "./types.js";

/** Create a fresh token-rate state object. */
export function createTokenRateState(): TokenRateState {
  return {
    turnStartMs: null,
    lastCompletedTps: null,
    hasLiveData: false,
    lastLiveUpdateMs: 0,
  };
}

/** Reset all state to initial values. */
export function resetTokenRateState(state: TokenRateState): void {
  state.turnStartMs = null;
  state.lastCompletedTps = null;
  state.hasLiveData = false;
  state.lastLiveUpdateMs = 0;
}

/** Start measuring a new assistant turn. */
export function startTurn(state: TokenRateState, timestamp?: number): void {
  state.turnStartMs = timestamp ?? Date.now();
  state.hasLiveData = false;
}

/** Compute and store TPS from a partial or final assistant message. */
export function computeTps(state: TokenRateState, message: RateAssistantMessage, isLive: boolean): number {
  if (state.turnStartMs === null) return 0;

  const effectiveTokens = getEffectiveTokens(message);
  if (effectiveTokens <= 0) return 0;

  const elapsedSec = Math.max(0.001, (Date.now() - state.turnStartMs) / 1000);
  const tps = Math.round(effectiveTokens / elapsedSec);
  if (!Number.isFinite(tps)) return 0;

  state.lastCompletedTps = tps;
  state.hasLiveData = isLive;
  return tps;
}

/** Mark a turn as complete while keeping the latest visible TPS value. */
export function finishTurn(state: TokenRateState): void {
  state.hasLiveData = false;
  state.turnStartMs = null;
}
