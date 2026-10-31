import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    DEFAULT_SUBAGENTS_CONFIG,
    decodeConfig,
    type CodexSubagentsConfig,
} from '../config/config.ts'
import { TokenBudgetExhaustedError } from '../domain/errors.ts'
import {
    DEFAULT_WARN_AT_RATIO,
    TokenBudget,
    describeLimits,
    resolveLimits,
} from './limits.ts'

function configured(limits: {
    runDeadlineMs?: number
    maxModelRequestsPerRun?: number
    maxTreeTokens?: number
    warnAtRatio?: number
}): CodexSubagentsConfig {
    return decodeConfig({ limits })
}

describe('resolved limits', () => {
    it('keeps M1 behavior unlimited when limits are absent', () => {
        const limits = resolveLimits(DEFAULT_SUBAGENTS_CONFIG)
        assert.equal(limits.runDeadlineMs, undefined)
        assert.equal(limits.maxModelRequestsPerRun, undefined)
        assert.equal(limits.maxTreeTokens, undefined)
        assert.equal(limits.warnAtRatio, DEFAULT_WARN_AT_RATIO)
        assert.equal(limits.unlimited, true)
        assert.equal(describeLimits(limits), '')
        assert.equal(
            describeLimits(resolveLimits(decodeConfig({ limits: {} }))),
            ''
        )
    })

    it('resolves only the configured bounds', () => {
        const partial = resolveLimits(configured({ maxModelRequestsPerRun: 7 }))
        assert.equal(partial.maxModelRequestsPerRun, 7)
        assert.equal(partial.runDeadlineMs, undefined)
        assert.equal(partial.maxTreeTokens, undefined)
        assert.equal(partial.unlimited, false)
        assert.equal(
            describeLimits(partial),
            'Limits: max 7 model requests per run.'
        )

        const all = resolveLimits(
            configured({
                runDeadlineMs: 900_000,
                maxModelRequestsPerRun: 40,
                maxTreeTokens: 500_000,
                warnAtRatio: 0.75,
            })
        )
        assert.deepEqual(
            { ...all },
            {
                runDeadlineMs: 900_000,
                maxModelRequestsPerRun: 40,
                maxTreeTokens: 500_000,
                warnAtRatio: 0.75,
                unlimited: false,
            }
        )
        assert.equal(
            describeLimits(all),
            'Limits: run deadline 900000 ms; max 40 model requests per run; max 500000 shared tree tokens; warn at 75%.'
        )
    })

    it('describes each bounded limit without unrelated text', () => {
        assert.equal(
            describeLimits(resolveLimits(configured({ runDeadlineMs: 1_000 }))),
            'Limits: run deadline 1000 ms.'
        )
        assert.equal(
            describeLimits(
                resolveLimits(
                    configured({ maxTreeTokens: 1_000, warnAtRatio: 0.55 })
                )
            ),
            'Limits: max 1000 shared tree tokens; warn at 55%.'
        )
    })
})

describe('TokenBudget', () => {
    it('never refuses admission when unlimited', () => {
        const budget = new TokenBudget()
        assert.deepEqual(budget.snapshot(), {
            consumed: 0,
            reserved: 0,
            remaining: Number.MAX_SAFE_INTEGER,
            exhausted: false,
            warning: false,
        })
        budget.checkAdmission()
        budget.reserve(10)
        budget.settle(10, 25)
        budget.record(5)
        budget.release(4)
        assert.equal(budget.snapshot().consumed, 30)
        assert.equal(budget.snapshot().reserved, 0)
        assert.equal(budget.snapshot().remaining, Number.MAX_SAFE_INTEGER)
        budget.checkAdmission()
    })

    it('accounts reservations, settled usage, and the warning threshold', () => {
        const budget = new TokenBudget(100, 0.8)
        assert.deepEqual(budget.snapshot(), {
            limit: 100,
            consumed: 0,
            reserved: 0,
            remaining: 100,
            exhausted: false,
            warning: false,
        })

        budget.reserve(50)
        assert.equal(budget.snapshot().remaining, 50)
        assert.equal(budget.snapshot().warning, false)

        budget.reserve(30)
        assert.equal(budget.snapshot().reserved, 80)
        assert.equal(budget.snapshot().remaining, 20)
        assert.equal(budget.snapshot().warning, true)
        assert.equal(budget.snapshot().exhausted, false)
        budget.checkAdmission()

        budget.settle(80, 65)
        assert.equal(budget.snapshot().consumed, 65)
        assert.equal(budget.snapshot().reserved, 0)
        assert.equal(budget.snapshot().remaining, 35)
        assert.equal(budget.snapshot().warning, false)

        budget.reserve(15)
        assert.equal(budget.snapshot().warning, true)
        budget.reserve(20)
        assert.equal(budget.snapshot().exhausted, true)
        assert.equal(budget.snapshot().remaining, 0)
        assert.throws(
            () => budget.checkAdmission(),
            (error: unknown) => {
                assert.ok(error instanceof TokenBudgetExhaustedError)
                assert.equal(error.code, 'budget_exhausted_tokens')
                assert.equal(error.consumed, 100)
                assert.equal(error.limit, 100)
                assert.match(error.guidance, /maxTreeTokens/)
                return true
            }
        )

        budget.release(10)
        assert.equal(budget.snapshot().exhausted, false)
        assert.equal(budget.snapshot().remaining, 10)
        budget.checkAdmission()
    })

    it('settles actual usage even when it overshoots the reservation', () => {
        const budget = new TokenBudget(100, 0.8)
        budget.reserve(10)
        budget.settle(10, 40)
        assert.equal(budget.snapshot().consumed, 40)
        assert.equal(budget.snapshot().reserved, 0)
        budget.record(70)
        assert.equal(budget.snapshot().consumed, 110)
        assert.equal(budget.snapshot().exhausted, true)
        assert.throws(() => budget.checkAdmission(), TokenBudgetExhaustedError)
    })

    it('clamps releases that exceed the outstanding reservation', () => {
        const budget = new TokenBudget(100)
        budget.reserve(5)
        budget.release(50)
        assert.equal(budget.snapshot().reserved, 0)
        budget.reserve(5)
        budget.settle(50, 1)
        assert.equal(budget.snapshot().reserved, 0)
        assert.equal(budget.snapshot().consumed, 1)
    })

    it('uses a custom warning ratio', () => {
        const budget = new TokenBudget(100, 0.5)
        budget.reserve(49)
        assert.equal(budget.snapshot().warning, false)
        budget.reserve(1)
        assert.equal(budget.snapshot().warning, true)
    })

    it('rejects invalid limits, ratios, and token amounts', () => {
        assert.throws(() => new TokenBudget(0), RangeError)
        assert.throws(() => new TokenBudget(1.5), RangeError)
        assert.throws(() => new TokenBudget(10, 0), RangeError)
        assert.throws(() => new TokenBudget(10, 1.01), RangeError)
        assert.throws(() => new TokenBudget(10, Number.NaN), RangeError)
        const budget = new TokenBudget(10)
        assert.throws(() => budget.reserve(-1), RangeError)
        assert.throws(() => budget.reserve(1.5), RangeError)
        assert.throws(() => budget.release(-1), RangeError)
        assert.throws(() => budget.settle(-1, 0), RangeError)
        assert.throws(() => budget.settle(0, -1), RangeError)
        assert.throws(() => budget.record(-1), RangeError)
    })
})
