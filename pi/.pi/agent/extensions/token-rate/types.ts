import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Mutable runtime state for the token-rate extension. */
export interface TokenRateState {
  turnStartMs: number | null;
  lastCompletedTps: number | null;
  hasLiveData: boolean;
  lastLiveUpdateMs: number;
}

/** Minimal UI context shape needed by status rendering. */
export interface TokenRateUiContext {
  hasUI: boolean;
  ui: {
    theme: { fg: (style: string, text: string) => string };
    setStatus: (key: string, text?: string) => void;
  };
}

/** Assistant message alias used by token counting helpers. */
export type RateAssistantMessage = AssistantMessage;
