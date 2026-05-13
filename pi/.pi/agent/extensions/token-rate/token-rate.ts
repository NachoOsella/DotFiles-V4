/**
 * Token Rate Status Extension
 *
 * Shows the output tokens per second (TPS) in the footer status line.
 * - Per-turn TPS: shows the last completed turn's rate.
 * - Live TPS: updates during streaming using actual usage data, or estimated
 *   from text content when usage data is not yet available (most providers).
 * - Resets on session start or switch.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const statusKey = "token-rate";

  // Throttle: only update UI every 2 seconds during streaming
  const LIVE_UPDATE_MS = 2000;

  // Per-turn state
  let turnStartMs: number | null = null;
  let lastCompletedTps: number | null = null;
  let hasLiveData: boolean = false;
  let lastLiveUpdateMs: number = 0;

  /**
   * Estimate output tokens from the partial message content.
   *
   * Most providers do not send usage data during streaming, so `usage.output`
   * is only available at `message_end`. During streaming we estimate tokens
   * from the text/source content length (~4 chars per token on average).
   *
   * This estimate is replaced by the exact value when `usage.output` arrives.
   */
  const estimateTokensFromContent = (content: AssistantMessage["content"]): number => {
    let chars = 0;
    for (const block of content) {
      if (block.type === "text") {
        chars += block.text.length;
      } else if (block.type === "thinking") {
        chars += block.thinking.length;
      } else if (block.type === "toolCall") {
        // Tool call arguments contain the data being written/edited
        chars += JSON.stringify(block.arguments).length;
      }
    }
    return Math.round(chars / 4);
  };

  /**
   * Get the effective output token count from a partial or final assistant message.
   *
   * Returns `usage.output` if available (non-zero), otherwise estimates from content.
   */
  const getEffectiveTokens = (msg: AssistantMessage): number => {
    const actual = msg.usage?.output ?? 0;
    if (actual > 0) return actual;
    return estimateTokensFromContent(msg.content);
  };

  /**
   * Format a TPS number for display. No decimals, e.g. "45" or "--" for NaN/Infinity.
   */
  const formatTps = (tps: number): string =>
    Number.isFinite(tps) ? String(Math.round(tps)) : "--";

  /**
   * Build the status text string based on current state.
   */
  const buildText = (theme: { fg: (style: string, text: string) => string }): string => {
    if (lastCompletedTps === null) {
      return theme.fg("dim", "TPS: --");
    }
    const value = formatTps(lastCompletedTps);
    return theme.fg("dim", "TPS: ") + theme.fg("accent", `${value} tok/s`);
  };

  /**
   * Update the footer status.
   */
  const updateStatus = (ctx: {
    hasUI: boolean;
    ui: { theme: { fg: (style: string, text: string) => string }; setStatus: (key: string, text?: string) => void };
  }): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(statusKey, buildText(ctx.ui.theme));
  };

  /**
   * Compute and store TPS from an assistant message (partial or final).
   * Returns the computed TPS, or 0 if it could not be computed.
   */
  const computeTps = (msg: AssistantMessage, isLive: boolean): number => {
    if (turnStartMs === null) return 0;

    const effectiveTokens = getEffectiveTokens(msg);
    if (effectiveTokens <= 0) return 0;

    const elapsedSec = Math.max(0.001, (Date.now() - turnStartMs) / 1000);
    const tps = Math.round(effectiveTokens / elapsedSec);
    if (!Number.isFinite(tps)) return 0;

    lastCompletedTps = tps;
    hasLiveData = isLive;
    return tps;
  };

  /**
   * Flush live TPS to UI if enough time has passed since the last update.
   * Returns true if the UI was updated.
   */
  const flushLive = (ctx: Parameters<typeof updateStatus>[0]): boolean => {
    const now = Date.now();
    if (now - lastLiveUpdateMs < LIVE_UPDATE_MS) return false;
    lastLiveUpdateMs = now;
    updateStatus(ctx);
    return true;
  };

  /**
   * Reset all state to initial values.
   */
  const reset = (ctx: Parameters<typeof updateStatus>[0]): void => {
    turnStartMs = null;
    lastCompletedTps = null;
    hasLiveData = false;
    updateStatus(ctx);
  };

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    reset(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    reset(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    turnStartMs = event.timestamp ?? Date.now();
    hasLiveData = false;
    // Keep lastCompletedTps visible during the turn; it will be replaced
    // by the first message_update or message_end.
    updateStatus(ctx);
  });

  /**
   * Live TPS during streaming, throttled to every 2 seconds.
   *
   * Fires for every content delta. We always compute the TPS internally (so the
   * stored value is accurate when queried), but only push to the UI at most once
   * every LIVE_UPDATE_MS to avoid excessive status bar flicker.
   *
   * When the partial message includes usage data (provider-dependent), we compute
   * the live rate from that. Otherwise we estimate tokens from the text/thinking/
   * toolCall content (~4 chars/token). The estimate is refined progressively as
   * more content streams in.
   */
  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (turnStartMs === null) return;

    const partial = event.assistantMessageEvent.partial as AssistantMessage;
    computeTps(partial, true);
    flushLive(ctx);
  });

  /**
   * Final TPS for the completed assistant message.
   *
   * This fires after the full assistant response has been received (including
   * tool calls embedded in the message). We compute the definitive TPS using
   * the actual usage.output from the provider and always update the UI (no
   * throttle).
   *
   * Using message_end instead of turn_end ensures we exclude tool execution time
   * from the measurement.
   */
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (turnStartMs === null) return;

    const msg = event.message as AssistantMessage;
    computeTps(msg, false);
    updateStatus(ctx);
  });

  /**
   * Turn end: reset streaming flag so the display settles to "idle" state.
   *
   * We intentionally do NOT compute TPS here because message_end is the correct
   * event for that — it fires right when the assistant finishes streaming,
   * before tool execution skews the timing.
   */
  pi.on("turn_end", async (_event, ctx) => {
    hasLiveData = false;
    turnStartMs = null;
    updateStatus(ctx);
  });
}
