import type { Model } from '@earendil-works/pi-ai'
import { ZEN_BASE_URL } from './config.ts'
import type { SupportedZenApi } from './types.ts'

const FREE_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
} as const

const CHAT_COMPAT = {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
} as const

/** Protocol-tested models available before a persisted catalog exists. */
export const BOOTSTRAP_MODELS: readonly Model<SupportedZenApi>[] = [
    {
        id: 'nemotron-3.5-lightning-free',
        name: 'Nemotron 3.5 Lightning Free',
        api: 'openai-completions',
        provider: 'zen-free',
        baseUrl: ZEN_BASE_URL,
        reasoning: true,
        input: ['text'],
        cost: FREE_COST,
        compat: CHAT_COMPAT,
        contextWindow: 262144,
        maxTokens: 262144,
    },
    {
        id: 'nemotron-3-ultra-free',
        name: 'Nemotron 3 Ultra Free',
        api: 'openai-completions',
        provider: 'zen-free',
        baseUrl: ZEN_BASE_URL,
        reasoning: true,
        input: ['text'],
        cost: FREE_COST,
        compat: CHAT_COMPAT,
        contextWindow: 1000000,
        maxTokens: 128000,
    },
    {
        id: 'big-pickle',
        name: 'Big Pickle',
        api: 'openai-completions',
        provider: 'zen-free',
        baseUrl: ZEN_BASE_URL,
        reasoning: true,
        input: ['text'],
        cost: FREE_COST,
        compat: CHAT_COMPAT,
        contextWindow: 200000,
        maxTokens: 32000,
    },
    {
        id: 'mimo-v2.5-free',
        name: 'MiMo V2.5 Free',
        api: 'openai-completions',
        provider: 'zen-free',
        baseUrl: ZEN_BASE_URL,
        reasoning: true,
        input: ['text', 'image'],
        cost: FREE_COST,
        compat: CHAT_COMPAT,
        contextWindow: 200000,
        maxTokens: 32000,
    },
    {
        id: 'hy3-free',
        name: 'Hy3 Free',
        api: 'openai-completions',
        provider: 'zen-free',
        baseUrl: ZEN_BASE_URL,
        reasoning: true,
        thinkingLevelMap: {
            off: null,
            minimal: null,
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: null,
            max: null,
        },
        input: ['text'],
        cost: FREE_COST,
        compat: CHAT_COMPAT,
        contextWindow: 190000,
        maxTokens: 64000,
    },
]
