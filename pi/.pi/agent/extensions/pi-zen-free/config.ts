import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** OpenCode Zen API endpoint used by the free provider. */
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/** Environment variable used by Pi for the provider API key. */
export const ZEN_KEY_VAR = "PI_ZEN_FREE_KEY";

/** Public model metadata endpoint used to discover zero-cost models. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Network timeout for metadata requests. */
export const FETCH_TIMEOUT_MS = 5000;

/** Default thinking level map for most reasoning models. */
export const DEFAULT_THINKING_LEVEL_MAP: ProviderModelConfig["thinkingLevelMap"] = {
  minimal: "low",
  xhigh: "high",
};

/** DeepSeek supports `max`; map Pi's xhigh level to the maximum effort. */
export const DEEPSEEK_THINKING_LEVEL_MAP: ProviderModelConfig["thinkingLevelMap"] = {
  minimal: "low",
  xhigh: "max",
};
