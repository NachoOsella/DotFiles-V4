import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeTps, createTokenRateState, finishTurn, resetTokenRateState, startTurn } from "./state.js";
import { flushLiveStatus, updateStatus } from "./status.js";

const STATUS_KEY = "token-rate";
const LIVE_UPDATE_MS = 2000;

/** Register a footer status extension that displays output tokens per second. */
export default function (pi: ExtensionAPI) {
  const state = createTokenRateState();

  pi.on("session_start", async (_event, ctx) => {
    resetTokenRateState(state);
    updateStatus(STATUS_KEY, state, ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    resetTokenRateState(state);
    updateStatus(STATUS_KEY, state, ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    startTurn(state, event.timestamp);
    updateStatus(STATUS_KEY, state, ctx);
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (state.turnStartMs === null) return;

    const partial = event.assistantMessageEvent.partial as AssistantMessage;
    computeTps(state, partial, true);
    flushLiveStatus(STATUS_KEY, state, ctx, LIVE_UPDATE_MS);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (state.turnStartMs === null) return;

    computeTps(state, event.message as AssistantMessage, false);
    updateStatus(STATUS_KEY, state, ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    finishTurn(state);
    updateStatus(STATUS_KEY, state, ctx);
  });
}
