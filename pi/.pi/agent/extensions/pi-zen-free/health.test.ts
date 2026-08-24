import assert from 'node:assert/strict'
import test from 'node:test'
import type { Model } from '@earendil-works/pi-ai'
import {
    normalizeFailure,
    parseRetryAfter,
    selectFallbackModel,
    ZenHealthTracker,
} from './health.ts'

function model(id: string): Model<'openai-completions'> {
    return {
        id,
        name: id,
        api: 'openai-completions',
        provider: 'zen-free',
        baseUrl: 'https://opencode.ai/zen/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16000,
    }
}

test('failure text is normalized without treating every rate limit as quota exhaustion', () => {
    assert.equal(
        normalizeFailure('FreeUsageLimitError: exhausted'),
        'quota_exhausted'
    )
    assert.equal(normalizeFailure('rate limit exceeded', 429), 'rate_limited')
    assert.equal(normalizeFailure('Model is unavailable'), 'model_unavailable')
    assert.equal(
        normalizeFailure('stream ended without a finish_reason'),
        'stream_truncated'
    )
    assert.equal(normalizeFailure('fetch failed: ECONNRESET'), 'network_error')
    assert.equal(
        normalizeFailure('context_length_exceeded'),
        'context_overflow'
    )
    assert.equal(
        normalizeFailure('invalid API key', 401),
        'authentication_error'
    )
})

test('generic 429 records response metadata without double-counting failure', () => {
    let now = 1_000
    const tracker = new ZenHealthTracker(() => now)
    tracker.recordHttpResponse('model', 429, { 'Retry-After': '30' })
    let health = tracker.getModelHealth('model')
    assert.equal(health.lastHttpStatus, 429)
    assert.equal(health.retryAfter, 31_000)
    assert.equal(health.consecutiveFailures, 0)

    tracker.recordFailure('model', 'rate_limited', {
        status: health.lastHttpStatus,
        retryAfter: health.retryAfter,
    })
    health = tracker.getModelHealth('model')
    assert.equal(health.failureCategory, 'rate_limited')
    assert.equal(health.consecutiveFailures, 1)
    assert.deepEqual(tracker.getProviderQuota(), { active: false })
    assert.equal(
        parseRetryAfter(
            { 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' },
            now
        ),
        60_000
    )
    now++
})

test('exact free usage exhaustion creates provider-wide cooldown', () => {
    let now = 5_000
    const tracker = new ZenHealthTracker(() => now)
    tracker.recordFailure('first', 'quota_exhausted')
    const quota = tracker.getProviderQuota()
    assert.equal(quota.active, true)
    assert.equal(quota.cooldownUntil, now + 60 * 60 * 1000)
    tracker.recordSuccess('first')
    assert.equal(tracker.getProviderQuota().active, true)
    now += 60 * 60 * 1000 + 1
    assert.equal(tracker.getProviderQuota().active, false)
})

test('model unavailable enters a 30-minute cooldown', () => {
    const now = 20_000
    const tracker = new ZenHealthTracker(() => now)
    tracker.recordFailure('model', 'model_unavailable')
    assert.equal(tracker.getModelHealth('model').state, 'cooldown')
    assert.equal(
        tracker.getModelHealth('model').cooldownUntil,
        now + 30 * 60 * 1000
    )
})

test('two transient failures within five minutes enter a 10-minute cooldown', () => {
    let now = 50_000
    const tracker = new ZenHealthTracker(() => now)
    tracker.recordFailure('model', 'network_error')
    assert.equal(tracker.getModelHealth('model').state, 'degraded')
    now += 4 * 60 * 1000
    tracker.recordFailure('model', 'server_error')
    assert.equal(tracker.getModelHealth('model').state, 'cooldown')
    assert.equal(
        tracker.getModelHealth('model').cooldownUntil,
        now + 10 * 60 * 1000
    )
})

test('success resets transient failures', () => {
    let now = 100_000
    const tracker = new ZenHealthTracker(() => now)
    tracker.recordFailure('model', 'network_error')
    tracker.recordSuccess('model')
    now += 1_000
    tracker.recordFailure('model', 'network_error')
    const health = tracker.getModelHealth('model')
    assert.equal(health.state, 'degraded')
    assert.equal(health.consecutiveFailures, 1)
})

test('fallback order excludes the current model and cooldown models', () => {
    const tracker = new ZenHealthTracker(() => 10_000)
    tracker.recordFailure('nemotron-3-ultra-free', 'model_unavailable')
    const selected = selectFallbackModel(
        [
            model('z-other'),
            model('big-pickle'),
            model('nemotron-3-ultra-free'),
            model('nemotron-3.5-lightning-free'),
        ],
        'nemotron-3.5-lightning-free',
        tracker
    )
    assert.equal(selected?.id, 'big-pickle')
})

test('provider quota cooldown excludes every fallback model', () => {
    const tracker = new ZenHealthTracker(() => 10_000)
    tracker.recordFailure('nemotron-3.5-lightning-free', 'quota_exhausted')
    const selected = selectFallbackModel(
        [model('big-pickle'), model('nemotron-3-ultra-free')],
        undefined,
        tracker
    )
    assert.equal(selected, undefined)
})
