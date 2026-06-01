import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

/** OpenCode Zen API endpoint used by the free provider. */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/** Environment variable used by Pi for the public provider API key. */
export const ZEN_KEY_VAR = 'PI_ZEN_FREE_KEY'

/** Public model metadata endpoint used to discover zero-cost models. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Network timeout for metadata requests. */
export const FETCH_TIMEOUT_MS = 5000

/** OpenCode CLI user agent shape expected by Zen free rate-limit buckets. */
export const OPENCODE_CLI_USER_AGENT =
    process.env.PI_ZEN_FREE_USER_AGENT ?? 'opencode/1.15.11'

/** Documented Zen free models used when models.dev stops exposing zero-cost metadata. */
export const FALLBACK_FREE_MODELS = [
    {
        id: 'deepseek-v4-flash-free',
        name: 'DeepSeek V4 Flash Free',
        reasoning: true,
        limit: { context: 128000, output: 16384 },
    },
    {
        id: 'mimo-v2.5-free',
        name: 'MiMo-V2.5 Free',
        reasoning: false,
        limit: { context: 128000, output: 16384 },
    },
    {
        id: 'nemotron-3-super-free',
        name: 'Nemotron 3 Super Free',
        reasoning: true,
        limit: { context: 128000, output: 16384 },
    },
    {
        id: 'big-pickle',
        name: 'Big Pickle',
        reasoning: true,
        limit: { context: 128000, output: 16384 },
    },
] as const

/** Default thinking level map for most reasoning models. */
export const DEFAULT_THINKING_LEVEL_MAP: ProviderModelConfig['thinkingLevelMap'] =
    {
        minimal: 'low',
        xhigh: 'high',
    }

/** DeepSeek supports `max`; map Pi's xhigh level to the maximum effort. */
export const DEEPSEEK_THINKING_LEVEL_MAP: ProviderModelConfig['thinkingLevelMap'] =
    {
        minimal: 'low',
        xhigh: 'max',
    }
