import type { Api, Model } from '@earendil-works/pi-ai'

export type HealthState = 'healthy' | 'degraded' | 'cooldown' | 'unknown'

export type FailureCategory =
    | 'quota_exhausted'
    | 'rate_limited'
    | 'model_unavailable'
    | 'endpoint_unavailable'
    | 'stream_truncated'
    | 'network_error'
    | 'server_error'
    | 'context_overflow'
    | 'authentication_error'
    | 'unknown'

export interface ModelHealth {
    state: HealthState
    consecutiveFailures: number
    lastFailureAt?: number
    cooldownUntil?: number
    failureCategory?: FailureCategory
    lastHttpStatus?: number
    retryAfter?: number
}

export interface ProviderQuotaHealth {
    active: boolean
    cooldownUntil?: number
}

interface InternalModelHealth extends ModelHealth {
    transientFailures: number[]
}

const MODEL_UNAVAILABLE_COOLDOWN_MS = 30 * 60 * 1000
const TRANSIENT_WINDOW_MS = 5 * 60 * 1000
const TRANSIENT_COOLDOWN_MS = 10 * 60 * 1000
const QUOTA_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
const TRANSIENT_CATEGORIES = new Set<FailureCategory>([
    'stream_truncated',
    'network_error',
    'server_error',
])

export const FALLBACK_ORDER = [
    'nemotron-3.5-lightning-free',
    'nemotron-3-ultra-free',
    'big-pickle',
    'mimo-v2.5-free',
    'hy3-free',
] as const

function parseResetValue(
    value: string | undefined,
    now: number
): number | undefined {
    if (!value) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds)) {
        if (seconds > 10_000_000_000) return seconds
        if (seconds > 1_000_000_000) return seconds * 1000
        if (seconds >= 0) return now + seconds * 1000
    }
    const date = Date.parse(value)
    return Number.isFinite(date) ? date : undefined
}

export function parseRetryAfter(
    headers: Record<string, string>,
    now = Date.now()
): number | undefined {
    const normalized = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
        ])
    )
    for (const name of [
        'retry-after',
        'x-ratelimit-reset',
        'x-ratelimit-reset-requests',
        'ratelimit-reset',
    ]) {
        const reset = parseResetValue(normalized[name], now)
        if (reset !== undefined) return reset
    }
    return undefined
}

export function normalizeFailure(
    errorText: string,
    httpStatus?: number
): FailureCategory {
    const text = errorText.toLowerCase()
    if (
        /freeusagelimiterror/i.test(errorText) ||
        /free(?:-| )?(?:tier )?usage limit (?:reached|exceeded|exhausted)/i.test(
            errorText
        )
    )
        return 'quota_exhausted'
    if (
        /context_length_exceeded|context window|maximum context|too many tokens/.test(
            text
        )
    )
        return 'context_overflow'
    if (
        /invalid api key|unauthori[sz]ed|authentication|forbidden/.test(text) ||
        httpStatus === 401 ||
        httpStatus === 403
    )
        return 'authentication_error'
    if (
        /model (?:is )?unavailable|model not available|unknown model/.test(text)
    )
        return 'model_unavailable'
    if (
        /endpoint (?:is )?unavailable|service unavailable|no healthy upstream/.test(
            text
        )
    )
        return 'endpoint_unavailable'
    if (
        /finish_reason|finish reason|stream ended|stream truncated|without a stop reason/.test(
            text
        )
    )
        return 'stream_truncated'
    if (
        /network_error|network error|fetch failed|econnreset|enotfound|socket|timed? out/.test(
            text
        )
    )
        return 'network_error'
    if (/rate limit|too many requests/.test(text) || httpStatus === 429)
        return 'rate_limited'
    if (httpStatus !== undefined && httpStatus >= 500) return 'server_error'
    if (/http 5\d\d|server error|internal server error/.test(text))
        return 'server_error'
    return 'unknown'
}

export class ZenHealthTracker {
    private readonly models = new Map<string, InternalModelHealth>()
    private readonly now: () => number
    private providerQuotaUntil?: number

    constructor(now: () => number = Date.now) {
        this.now = now
    }

    private model(id: string): InternalModelHealth {
        let health = this.models.get(id)
        if (!health) {
            health = {
                state: 'unknown',
                consecutiveFailures: 0,
                transientFailures: [],
            }
            this.models.set(id, health)
        }
        return health
    }

    recordHttpResponse(
        modelId: string,
        status: number,
        headers: Record<string, string>
    ): void {
        const health = this.model(modelId)
        health.lastHttpStatus = status
        const retryAfter = parseRetryAfter(headers, this.now())
        if (retryAfter !== undefined) health.retryAfter = retryAfter
    }

    recordFailure(
        modelId: string,
        category: FailureCategory,
        options: { status?: number; retryAfter?: number } = {}
    ): void {
        const now = this.now()
        const health = this.model(modelId)
        health.consecutiveFailures++
        health.lastFailureAt = now
        health.failureCategory = category
        if (options.status !== undefined) health.lastHttpStatus = options.status
        if (options.retryAfter !== undefined)
            health.retryAfter = options.retryAfter
        health.state = 'degraded'

        if (category === 'quota_exhausted') {
            this.providerQuotaUntil =
                options.retryAfter ?? now + QUOTA_DEFAULT_COOLDOWN_MS
            health.state = 'cooldown'
            health.cooldownUntil = this.providerQuotaUntil
            return
        }
        if (
            category === 'model_unavailable' ||
            category === 'endpoint_unavailable'
        ) {
            health.state = 'cooldown'
            health.cooldownUntil = now + MODEL_UNAVAILABLE_COOLDOWN_MS
            return
        }
        if (TRANSIENT_CATEGORIES.has(category)) {
            health.transientFailures = health.transientFailures.filter(
                (timestamp) => now - timestamp <= TRANSIENT_WINDOW_MS
            )
            health.transientFailures.push(now)
            if (health.transientFailures.length >= 2) {
                health.state = 'cooldown'
                health.cooldownUntil = now + TRANSIENT_COOLDOWN_MS
            }
        }
    }

    recordSuccess(modelId: string): void {
        const health = this.model(modelId)
        health.state = 'healthy'
        health.consecutiveFailures = 0
        health.transientFailures = []
        health.lastFailureAt = undefined
        health.failureCategory = undefined
        health.cooldownUntil = undefined
        health.retryAfter = undefined
    }

    getModelHealth(modelId: string): ModelHealth {
        const health = this.models.get(modelId)
        if (!health) return { state: 'unknown', consecutiveFailures: 0 }
        const copy: ModelHealth = { ...health }
        if (
            copy.cooldownUntil !== undefined &&
            copy.cooldownUntil <= this.now()
        ) {
            copy.cooldownUntil = undefined
            copy.state = copy.consecutiveFailures > 0 ? 'degraded' : 'unknown'
        }
        return copy
    }

    getAllModelHealth(): ReadonlyMap<string, ModelHealth> {
        return new Map(
            [...this.models].map(([id]) => [id, this.getModelHealth(id)])
        )
    }

    getProviderQuota(): ProviderQuotaHealth {
        if (
            this.providerQuotaUntil === undefined ||
            this.providerQuotaUntil <= this.now()
        )
            return { active: false }
        return { active: true, cooldownUntil: this.providerQuotaUntil }
    }

    isCoolingDown(modelId: string): boolean {
        return this.getModelHealth(modelId).state === 'cooldown'
    }

    clear(): void {
        this.models.clear()
        this.providerQuotaUntil = undefined
    }
}

export function selectFallbackModel(
    models: readonly Model<Api>[],
    currentModelId: string | undefined,
    health: ZenHealthTracker
): Model<Api> | undefined {
    if (health.getProviderQuota().active) return undefined
    const available = models.filter(
        (model) =>
            model.provider === 'zen-free' &&
            model.id !== currentModelId &&
            !health.isCoolingDown(model.id)
    )
    const rank = new Map<string, number>(
        FALLBACK_ORDER.map((id, index) => [id, index])
    )
    return available.sort((left, right) => {
        const leftRank = rank.get(left.id) ?? FALLBACK_ORDER.length
        const rightRank = rank.get(right.id) ?? FALLBACK_ORDER.length
        return leftRank - rightRank || left.id.localeCompare(right.id)
    })[0]
}
