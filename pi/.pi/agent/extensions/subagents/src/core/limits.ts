/**
 * Pure limit policy and shared tree token accounting.
 *
 * Absent configuration resolves to unlimited limits. The token budget tracks
 * settled usage plus outstanding reservations, so callers can refuse admission
 * before starting work and settle the reservation against real usage later.
 * In-flight work can still overshoot the limit because reservations are
 * estimates and are never cancelled retroactively.
 */

import type { CodexSubagentsConfig } from '../config/config.ts'
import { TokenBudgetExhaustedError } from '../domain/errors.ts'

/** Default warning threshold for the shared tree token budget. */
export const DEFAULT_WARN_AT_RATIO = 0.8

/** Reported remaining capacity for an unlimited budget. */
const UNLIMITED_REMAINING = Number.MAX_SAFE_INTEGER

export interface ResolvedLimits {
    readonly runDeadlineMs?: number
    readonly maxModelRequestsPerRun?: number
    readonly maxTreeTokens?: number
    readonly warnAtRatio: number
    readonly unlimited: boolean
}

/** Resolve validated configuration into the policy enforced by the runtime. */
export function resolveLimits(config: CodexSubagentsConfig): ResolvedLimits {
    const limits = config.limits
    return {
        runDeadlineMs: limits?.runDeadlineMs,
        maxModelRequestsPerRun: limits?.maxModelRequestsPerRun,
        maxTreeTokens: limits?.maxTreeTokens,
        warnAtRatio: limits?.warnAtRatio ?? DEFAULT_WARN_AT_RATIO,
        unlimited:
            limits?.runDeadlineMs === undefined &&
            limits?.maxModelRequestsPerRun === undefined &&
            limits?.maxTreeTokens === undefined,
    }
}

/**
 * Human-readable limit line for model prompts.
 *
 * Returns an empty string when nothing is bounded so unlimited defaults add no
 * prompt text. The warning ratio is only rendered with a token budget.
 */
export function describeLimits(limits: ResolvedLimits): string {
    const parts: string[] = []
    if (limits.runDeadlineMs !== undefined) {
        parts.push(`run deadline ${limits.runDeadlineMs} ms`)
    }
    if (limits.maxModelRequestsPerRun !== undefined) {
        parts.push(
            `max ${limits.maxModelRequestsPerRun} model requests per run`
        )
    }
    if (limits.maxTreeTokens !== undefined) {
        parts.push(`max ${limits.maxTreeTokens} shared tree tokens`)
    }
    if (parts.length === 0) return ''
    const warning =
        limits.maxTreeTokens === undefined
            ? ''
            : `; warn at ${Math.round(limits.warnAtRatio * 100)}%`
    return `Limits: ${parts.join('; ')}${warning}.`
}

export interface TokenBudgetSnapshot {
    readonly limit?: number
    readonly consumed: number
    readonly reserved: number
    readonly remaining: number
    readonly exhausted: boolean
    readonly warning: boolean
}

/**
 * Shared accounting for one root tree.
 *
 * `remaining` is a pre-admission estimate that subtracts outstanding
 * reservations. `consumed` only grows through `settle` and `record`; releasing
 * a reservation never refunds settled usage.
 */
export class TokenBudget {
    private readonly limit?: number
    private readonly warnAtRatio: number
    private consumed = 0
    private reserved = 0

    constructor(limit?: number, warnAtRatio: number = DEFAULT_WARN_AT_RATIO) {
        if (limit !== undefined && (!isPositiveInteger(limit) || limit < 1)) {
            throw new RangeError('Token budget limit must be an integer >= 1')
        }
        if (
            !Number.isFinite(warnAtRatio) ||
            warnAtRatio <= 0 ||
            warnAtRatio > 1
        ) {
            throw new RangeError(
                'Token budget warnAtRatio must be a number > 0 and <= 1'
            )
        }
        this.limit = limit
        this.warnAtRatio = warnAtRatio
    }

    snapshot(): TokenBudgetSnapshot {
        const committed = this.consumed + this.reserved
        const remaining =
            this.limit === undefined
                ? UNLIMITED_REMAINING
                : Math.max(0, this.limit - committed)
        return {
            ...(this.limit === undefined ? {} : { limit: this.limit }),
            consumed: this.consumed,
            reserved: this.reserved,
            remaining,
            exhausted: this.limit !== undefined && committed >= this.limit,
            warning:
                this.limit !== undefined &&
                committed >= this.limit * this.warnAtRatio,
        }
    }

    /** Refuse new work when the committed budget leaves no room. */
    checkAdmission(): void {
        if (this.limit === undefined) return
        const committed = this.consumed + this.reserved
        if (committed >= this.limit) {
            throw new TokenBudgetExhaustedError(committed, this.limit)
        }
    }

    reserve(tokens: number): void {
        assertTokens(tokens, 'reserve')
        this.reserved += tokens
    }

    release(tokens: number): void {
        assertTokens(tokens, 'release')
        this.reserved = Math.max(0, this.reserved - tokens)
    }

    /** Replace a reservation with the usage it actually produced. */
    settle(reserved: number, actual: number): void {
        assertTokens(reserved, 'settle.reserved')
        assertTokens(actual, 'settle.actual')
        this.reserved = Math.max(0, this.reserved - reserved)
        this.consumed += actual
    }

    /** Record settled usage that never had a reservation. */
    record(tokens: number): void {
        assertTokens(tokens, 'record')
        this.consumed += tokens
    }
}

function isPositiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1
}

function assertTokens(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} tokens must be an integer >= 0`)
    }
}
