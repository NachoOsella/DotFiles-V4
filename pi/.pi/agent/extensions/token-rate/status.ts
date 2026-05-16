import type { TokenRateState, TokenRateUiContext } from "./types.js";

/** Format a TPS number for display. */
function formatTps(tps: number): string {
  return Number.isFinite(tps) ? String(Math.round(tps)) : "--";
}

/** Build the footer status text from current state. */
export function buildStatusText(
  state: TokenRateState,
  theme: { fg: (style: string, text: string) => string },
): string {
  if (state.lastCompletedTps === null) {
    return theme.fg("dim", "TPS: --");
  }
  const value = formatTps(state.lastCompletedTps);
  return theme.fg("dim", "TPS: ") + theme.fg("accent", `${value} tok/s`);
}

/** Update the token-rate footer status when an interactive UI is present. */
export function updateStatus(statusKey: string, state: TokenRateState, ctx: TokenRateUiContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(statusKey, buildStatusText(state, ctx.ui.theme));
}

/** Throttle live updates to avoid status bar flicker during streaming. */
export function flushLiveStatus(
  statusKey: string,
  state: TokenRateState,
  ctx: TokenRateUiContext,
  liveUpdateMs: number,
): boolean {
  const now = Date.now();
  if (now - state.lastLiveUpdateMs < liveUpdateMs) return false;
  state.lastLiveUpdateMs = now;
  updateStatus(statusKey, state, ctx);
  return true;
}
