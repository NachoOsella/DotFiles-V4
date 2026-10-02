import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
    appendOverflowIndicator,
    columns,
    fitFooterSegments,
    formatGitLabel,
    formatModelLabel,
    formatSubagentCount,
    formatThroughput,
    formatUsageLabel,
    normalizeWidth,
    packExtensionStatuses,
    type FooterFitInput,
} from './src/dashboard-layout.ts'

const WIDTHS = [1, 2, 3, 5, 10, 20, 40, 80, 120, 160]

function footerInput(overrides: Partial<FooterFitInput> = {}): FooterFitInput {
    return {
        width: 80,
        directory: '~/project',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinking: 'off',
        contextPercent: 42,
        contextWindow: 200_000,
        cost: 1.23,
        tokensPerSecond: 12,
        throughputIsEstimate: false,
        branch: 'main',
        changedFiles: 2,
        pullRequestNumber: 7,
        ...overrides,
    }
}

describe('width normalization', () => {
    it('clamps degenerate widths', () => {
        assert.equal(normalizeWidth(NaN), 80)
        assert.equal(normalizeWidth(0), 1)
    })
})

describe('footer columns', () => {
    it('stays within widths 1-160', () => {
        for (const width of WIDTHS) {
            const line = columns('left', 'right', width)
            assert.ok(visibleWidth(line) <= Math.max(1, width))
        }
    })
})

describe('footer degradation', () => {
    it('keeps the legacy label shapes on wide terminals', () => {
        assert.equal(formatModelLabel('', 'no-model', 'off'), 'no-model')
        assert.equal(
            formatModelLabel('anthropic', 'claude', 'off'),
            'anthropic/claude · off'
        )
    })
    it('keeps full detail on wide terminals', () => {
        const fit = fitFooterSegments(footerInput({ width: 160 }))
        assert.deepEqual(fit.dropped, [])
        assert.ok(fit.row1Right.includes('anthropic/'))
        assert.ok(fit.row2Left.includes('tok/s'))
        assert.ok(fit.row2Right.includes('PR #7'))
    })

    it('drops optional segments before critical state, in priority order', () => {
        const fit = fitFooterSegments(
            footerInput({
                width: 40,
                directory: '~/a/very/long/project/path/that/keeps/going',
                pullRequestNumber: 12345,
            })
        )
        assert.ok(fit.dropped.length > 0)
        assert.deepEqual(
            fit.dropped,
            ['pr', 'throughput', 'provider-prefix', 'path'].slice(
                0,
                fit.dropped.length
            )
        )
        // Critical state survives degradation: model id and context percent.
        assert.ok(fit.row1Right.includes('claude-sonnet-4-5'))
        assert.ok(fit.row2Left.includes('42%'))
    })

    it('short rows fit without any drops', () => {
        const fit = fitFooterSegments(
            footerInput({
                width: 80,
                directory: '~',
                provider: '',
                modelId: 'm',
                thinking: 'off',
                pullRequestNumber: null,
            })
        )
        assert.deepEqual(fit.dropped, [])
    })
})

describe('subagent labels', () => {
    it('shows active counts and hides an empty count', () => {
        assert.equal(formatSubagentCount(0), '')
        assert.equal(formatSubagentCount(1), '● 1 subagent')
        assert.equal(formatSubagentCount(3.8), '● 3 subagents')
        assert.equal(formatSubagentCount(Number.NaN), '')
    })
})

describe('throughput labels', () => {
    it('marks live estimates with ~ and measured cadence without', () => {
        assert.equal(formatThroughput(12.4, true), '~12 tok/s')
        assert.equal(formatThroughput(12.4, false), '12 tok/s')
        assert.equal(formatThroughput(null, true), '— tok/s')
        assert.equal(formatThroughput(NaN, false), '— tok/s')
        assert.equal(formatThroughput(Infinity, true), '— tok/s')
    })

    it('omits throughput from usage labels only when dropped', () => {
        const full = formatUsageLabel({
            contextPercent: 42,
            contextWindow: 200_000,
            cost: 1.23,
            throughput: '~12 tok/s',
        })
        assert.ok(full.includes('tok/s'))
        const withSubagents = formatUsageLabel({
            contextPercent: 42,
            contextWindow: 200_000,
            cost: 1.23,
            throughput: '80 tok/s',
            subagentsRunning: 2,
        })
        assert.ok(withSubagents.includes('80 tok/s · ● 2 subagents'))
        const slim = formatUsageLabel({
            contextPercent: 42,
            contextWindow: 200_000,
            cost: 1.23,
            throughput: '~12 tok/s',
            includeThroughput: false,
        })
        assert.ok(!slim.includes('tok/s'))
        assert.ok(slim.includes('42%'))
    })

    it('shows the session cache share the way /stats computes it', () => {
        const base = {
            contextPercent: 10,
            contextWindow: 1000,
            throughput: '--',
        }
        // cacheRead / (input + cacheRead + cacheWrite), parent plus children.
        assert.ok(
            formatUsageLabel({
                ...base,
                cost: 1,
                promptTokens: { input: 300, cacheRead: 600, cacheWrite: 100 },
            }).includes('CH60.0%')
        )
        assert.ok(
            formatUsageLabel({
                ...base,
                cost: 1,
                promptTokens: { input: 200, cacheRead: 100, cacheWrite: 100 },
            }).includes('CH25.0%')
        )
        // No prompt tokens or no cache activity: the segment stays hidden.
        assert.doesNotMatch(formatUsageLabel({ ...base, cost: 1 }), /CH/)
        assert.doesNotMatch(
            formatUsageLabel({
                ...base,
                cost: 1,
                promptTokens: { input: 500, cacheRead: 0, cacheWrite: 0 },
            }),
            /CH/
        )
    })

    it('does not round small non-zero session costs down to zero', () => {
        const input = {
            contextPercent: 10,
            contextWindow: 1000,
            throughput: '--',
        }
        assert.ok(
            formatUsageLabel({ ...input, cost: 0.003 }).includes('$0.003000')
        )
        assert.ok(
            formatUsageLabel({ ...input, cost: 0.0000001 }).includes(
                '<$0.000001'
            )
        )
    })

    it('handles unknown context windows and non-finite costs', () => {
        const label = formatUsageLabel({
            contextPercent: null,
            contextWindow: 0,
            cost: NaN,
            throughput: '— tok/s',
        })
        assert.ok(label.includes('?'))
        assert.ok(label.includes('$0.00'))
    })
})

describe('git labels', () => {
    it('renders branch state and optional stale marker', () => {
        assert.equal(
            formatGitLabel({
                branch: 'main',
                changedFiles: 2,
                pullRequestNumber: 7,
            }),
            'main · 2 files changed · PR #7'
        )
        assert.equal(
            formatGitLabel({
                branch: 'main',
                changedFiles: 1,
                pullRequestNumber: null,
            }),
            'main · 1 file changed'
        )
        assert.ok(
            formatGitLabel({
                branch: 'main',
                changedFiles: 0,
                pullRequestNumber: null,
                stale: true,
            }).includes('(stale)')
        )
        assert.equal(
            formatGitLabel({
                branch: null,
                changedFiles: 0,
                pullRequestNumber: 1,
            }),
            ''
        )
    })
})

describe('extension status packing', () => {
    it('packs short statuses and never silently deletes any', () => {
        const statuses = ['a', 'b', 'c']
        const packed = packExtensionStatuses(statuses, 80)
        assert.deepEqual(packed.lines, ['a · b · c'])
        assert.equal(packed.overflow, 0)
    })

    it('reports overflow counts instead of dropping statuses', () => {
        const statuses = ['alpha', 'beta', 'gamma', 'delta']
        const packed = packExtensionStatuses(statuses, 12, 1)
        assert.equal(packed.lines.length, 1)
        assert.ok(packed.overflow > 0)
        const shown = packed.lines[0]!.split(' · ').length
        assert.equal(shown + packed.overflow, statuses.length)
        for (const line of packed.lines) {
            assert.ok(visibleWidth(line) <= 12)
        }
    })

    it('keeps an overlong single status as a truncated row', () => {
        const packed = packExtensionStatuses(['x'.repeat(50)], 10, 1)
        assert.equal(packed.lines.length, 1)
        assert.equal(packed.overflow, 0)
        assert.ok(visibleWidth(packed.lines[0]!) <= 10)
    })

    it('respects max lines and width 1', () => {
        const packed = packExtensionStatuses(['a', 'b', 'c', 'd'], 1, 1)
        assert.equal(packed.lines.length, 1)
        assert.ok(visibleWidth(packed.lines[0]!) <= 1)
        assert.ok(packed.overflow >= 0)
        assert.equal(
            packed.lines[0]!.split(' · ').length + packed.overflow >= 4,
            true
        )
    })

    it('appends overflow indicators within width', () => {
        assert.equal(appendOverflowIndicator('a · b', 0, 80), 'a · b')
        const withMore = appendOverflowIndicator('a · b', 3, 80)
        assert.ok(withMore.includes('+3 more'))
        const tight = appendOverflowIndicator('a · b · c', 2, 10)
        assert.ok(visibleWidth(tight) <= 10)
        assert.ok(tight.includes('+2 more'))
    })
})
