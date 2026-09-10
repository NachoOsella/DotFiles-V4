import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    clampWaitTimeout,
    decodeConfig,
    DEFAULT_SUBAGENTS_CONFIG,
} from './src/config.ts'
import { modeInstructions, resolveMode } from './src/mode.ts'
import {
    assembleChildPrompt,
    assembleRootPrompt,
    rootRoleInstructions,
    subagentRoleInstructions,
} from './src/prompts.ts'
import { assertNoForbiddenTools, plannedV2Tools } from './src/tool-specs.ts'

describe('config', () => {
    it('decodes defaults and validates wait ordering', () => {
        assert.deepEqual(decodeConfig(undefined), DEFAULT_SUBAGENTS_CONFIG)
        assert.equal(DEFAULT_SUBAGENTS_CONFIG.defaultWaitTimeoutMs, 60_000)
        assert.throws(() =>
            decodeConfig({
                minWaitTimeoutMs: 5_000,
                defaultWaitTimeoutMs: 1_000,
            })
        )
        assert.throws(() => decodeConfig({ maxConcurrentAgents: 0 }))
    })

    it('clamps below-minimum waits and rejects above-maximum', () => {
        const clamped = clampWaitTimeout(DEFAULT_SUBAGENTS_CONFIG, 1)
        assert.equal(
            clamped.effectiveMs,
            DEFAULT_SUBAGENTS_CONFIG.minWaitTimeoutMs
        )
        assert.ok(clamped.note)
        assert.equal(clamped.rejected, null)

        const rejected = clampWaitTimeout(
            DEFAULT_SUBAGENTS_CONFIG,
            DEFAULT_SUBAGENTS_CONFIG.maxWaitTimeoutMs + 1
        )
        assert.ok(rejected.rejected)

        const normal = clampWaitTimeout(DEFAULT_SUBAGENTS_CONFIG, undefined)
        assert.equal(
            normal.effectiveMs,
            DEFAULT_SUBAGENTS_CONFIG.defaultWaitTimeoutMs
        )
    })
})

describe('mode', () => {
    it('defaults to explicit-only without a verified Ultra signal', () => {
        assert.deepEqual(resolveMode({ ultraReasoning: false }), {
            _tag: 'ExplicitRequestOnly',
        })
        assert.deepEqual(resolveMode({ ultraReasoning: true }), {
            _tag: 'Proactive',
        })
        assert.deepEqual(
            resolveMode({ ultraReasoning: false, customModeHint: 'custom' }),
            { _tag: 'Custom', hint: 'custom' }
        )
        // Empty custom hint suppresses the fragment.
        assert.equal(modeInstructions({ _tag: 'Custom', hint: '  ' }), null)
        assert.ok(
            modeInstructions({ _tag: 'ExplicitRequestOnly' })?.includes(
                'explicit-only'
            )
        )
    })
})

describe('prompts', () => {
    const input = {
        config: DEFAULT_SUBAGENTS_CONFIG,
        mode: resolveMode({ ultraReasoning: false }),
        activeSlotCount: 4,
    }

    it('covers the required meaning clauses', () => {
        const root = assembleRootPrompt(input)
        for (const clause of [
            '/root',
            'spawn_agent',
            'followup_task',
            'send_message',
            'fork_turns',
            'FINAL_ANSWER',
            'same filesystem',
            '4 slot',
        ]) {
            assert.ok(root.includes(clause), `root prompt misses: ${clause}`)
        }
        const child = assembleChildPrompt(input)
        assert.ok(child.includes('FINAL_ANSWER'))
        assert.ok(!child.includes('/root, the primary'))
    })

    it('honors configured overrides including empty suppression', () => {
        const custom = {
            ...DEFAULT_SUBAGENTS_CONFIG,
            rootAgentUsageHintText: 'custom root',
        }
        assert.equal(rootRoleInstructions(custom), 'custom root')
        const suppressed = {
            ...DEFAULT_SUBAGENTS_CONFIG,
            rootAgentUsageHintText: '  ',
            subagentUsageHintText: '',
        }
        assert.equal(rootRoleInstructions(suppressed), null)
        assert.equal(subagentRoleInstructions(suppressed), null)
        const assembled = assembleRootPrompt({ ...input, config: suppressed })
        assert.ok(!assembled.includes('You are /root'))
    })

    it('conditions wait guidance on tool exposure', () => {
        const withoutWait = assembleRootPrompt({
            ...input,
            config: { ...DEFAULT_SUBAGENTS_CONFIG, waitAgentEnabled: false },
        })
        assert.ok(!withoutWait.includes('wait_agent'))
    })
})

describe('tool plan', () => {
    it('exposes the exact six-tool family and no V1 names', () => {
        assert.deepEqual(plannedV2Tools({ waitAgentEnabled: true }), [
            'spawn_agent',
            'send_message',
            'followup_task',
            'wait_agent',
            'interrupt_agent',
            'list_agents',
        ])
        assert.deepEqual(plannedV2Tools({ waitAgentEnabled: false }), [
            'spawn_agent',
            'send_message',
            'followup_task',
            'interrupt_agent',
            'list_agents',
        ])
        assert.throws(() => assertNoForbiddenTools(['close_agent']))
        assert.throws(() => assertNoForbiddenTools(['resume_agent']))
        assert.throws(() => assertNoForbiddenTools(['send_input']))
    })
})
