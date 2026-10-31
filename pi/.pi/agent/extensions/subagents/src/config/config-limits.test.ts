import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    ConfigValidationError,
    DEFAULT_SUBAGENTS_CONFIG,
    decodeConfig,
} from './config.ts'
import { resolveLimits } from '../core/limits.ts'

describe('limits config', () => {
    it('keeps limits absent by default for M1 parity', () => {
        assert.equal(DEFAULT_SUBAGENTS_CONFIG.limits, undefined)
        assert.equal(decodeConfig(undefined).limits, undefined)
        assert.equal(decodeConfig({}).limits, undefined)
        assert.equal(resolveLimits(decodeConfig({})).unlimited, true)
    })

    it('decodes a fully configured limits block', () => {
        const config = decodeConfig({
            limits: {
                runDeadlineMs: 900_000,
                maxModelRequestsPerRun: 40,
                maxTreeTokens: 500_000,
                warnAtRatio: 0.75,
            },
        })
        assert.deepEqual(config.limits, {
            runDeadlineMs: 900_000,
            maxModelRequestsPerRun: 40,
            maxTreeTokens: 500_000,
            warnAtRatio: 0.75,
        })
        assert.deepEqual(resolveLimits(config), {
            runDeadlineMs: 900_000,
            maxModelRequestsPerRun: 40,
            maxTreeTokens: 500_000,
            warnAtRatio: 0.75,
            unlimited: false,
        })
    })

    it('defaults warnAtRatio to 0.8 and preserves partial blocks', () => {
        assert.deepEqual(
            decodeConfig({ limits: { maxTreeTokens: 1_000 } }).limits,
            { maxTreeTokens: 1_000, warnAtRatio: 0.8 }
        )
        assert.deepEqual(decodeConfig({ limits: {} }).limits, {
            warnAtRatio: 0.8,
        })
        const partial = decodeConfig({
            limits: { runDeadlineMs: 5_000 },
        })
        assert.deepEqual(resolveLimits(partial), {
            runDeadlineMs: 5_000,
            maxModelRequestsPerRun: undefined,
            maxTreeTokens: undefined,
            warnAtRatio: 0.8,
            unlimited: false,
        })
    })

    it('ignores unknown keys inside limits', () => {
        const config = decodeConfig({
            limits: { maxTreeTokens: 10, futureLimit: 3 },
        })
        assert.deepEqual(config.limits, {
            maxTreeTokens: 10,
            warnAtRatio: 0.8,
        })
    })

    it('rejects malformed limits blocks', () => {
        for (const limits of [null, [], 'none', 3, true]) {
            assert.throws(() => decodeConfig({ limits }), ConfigValidationError)
        }
    })

    it('rejects non-positive and non-integer deadline values', () => {
        for (const runDeadlineMs of [
            0,
            -1,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            '1000',
            null,
        ]) {
            assert.throws(
                () => decodeConfig({ limits: { runDeadlineMs } }),
                ConfigValidationError
            )
        }
    })

    it('rejects invalid request and token limits', () => {
        for (const value of [0, -1, 2.5, '40', null]) {
            assert.throws(
                () =>
                    decodeConfig({
                        limits: { maxModelRequestsPerRun: value },
                    }),
                ConfigValidationError
            )
            assert.throws(
                () => decodeConfig({ limits: { maxTreeTokens: value } }),
                ConfigValidationError
            )
        }
    })

    it('rejects warnAtRatio outside (0, 1]', () => {
        for (const warnAtRatio of [
            0,
            -0.1,
            1.01,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            '0.8',
            null,
        ]) {
            assert.throws(
                () => decodeConfig({ limits: { warnAtRatio } }),
                ConfigValidationError
            )
        }
        assert.equal(
            decodeConfig({ limits: { warnAtRatio: 1 } }).limits?.warnAtRatio,
            1
        )
    })
})
