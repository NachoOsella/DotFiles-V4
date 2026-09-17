import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    clampWaitTimeout,
    decodeConfig,
    DEFAULT_SUBAGENTS_CONFIG,
} from './src/config.ts'
import {
    modeInstructions,
    resolveConfiguredMode,
    resolveMode,
} from './src/mode.ts'
import {
    assembleChildPrompt,
    assembleRootPrompt,
    rootRoleInstructions,
    subagentRoleInstructions,
} from './src/prompts.ts'
import {
    assertNoForbiddenTools,
    buildSpawnAgentParams,
    buildWaitAgentParams,
    plannedV2Tools,
} from './src/tool-specs.ts'

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
        assert.deepEqual(
            resolveConfiguredMode(
                { ...DEFAULT_SUBAGENTS_CONFIG, proactiveAt: 'high' },
                'xhigh'
            ),
            { _tag: 'Proactive' }
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
            '4 child-agent run',
        ]) {
            assert.ok(root.includes(clause), `root prompt misses: ${clause}`)
        }
        const child = assembleChildPrompt(input)
        assert.ok(child.includes('FINAL_ANSWER'))
        assert.ok(!child.includes('/root, the primary'))
        assert.match(child, /may spawn nested agents/)

        const nestedChild = assembleChildPrompt({
            ...input,
            config: { ...DEFAULT_SUBAGENTS_CONFIG, maxDepth: 2 },
            currentDepth: 0,
        })
        assert.match(nestedChild, /may spawn nested agents/)
    })

    it('appends configured hints without replacing collaboration invariants', () => {
        const custom = {
            ...DEFAULT_SUBAGENTS_CONFIG,
            rootAgentUsageHintText: 'custom root',
        }
        const rootRole = rootRoleInstructions(custom)
        assert.ok(rootRole?.includes('You are /root'))
        assert.ok(rootRole?.includes('custom root'))
        const suppressed = {
            ...DEFAULT_SUBAGENTS_CONFIG,
            rootAgentUsageHintText: '  ',
            subagentUsageHintText: '',
        }
        assert.ok(rootRoleInstructions(suppressed)?.includes('You are /root'))
        assert.ok(
            subagentRoleInstructions(suppressed)?.includes('You are one agent')
        )
        const assembled = assembleRootPrompt({ ...input, config: suppressed })
        assert.ok(assembled.includes('You are /root'))
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
    it('builds spawn metadata from resolved config', () => {
        const schema = buildSpawnAgentParams({
            exposeSpawnAgentModelOverrides: false,
            hideSpawnAgentMetadata: true,
            roles: { reviewer: {} },
        }) as { properties: Record<string, unknown> }
        assert.ok(!('agent_type' in schema.properties))
        assert.ok(!('model' in schema.properties))
        assert.ok(!('reasoning_effort' in schema.properties))
        assert.ok('fork_turns' in schema.properties)
    })

    it('includes default when custom agent types are exposed', () => {
        const schema = buildSpawnAgentParams({
            exposeSpawnAgentModelOverrides: false,
            hideSpawnAgentMetadata: false,
            roles: { reviewer: {} },
        }) as {
            properties: {
                agent_type: { anyOf: Array<{ const: string }> }
            }
        }
        assert.deepEqual(
            schema.properties.agent_type.anyOf.map((entry) => entry.const),
            ['default', 'reviewer']
        )
    })

    it('omits agent_type when no custom roles are valid', () => {
        const schema = buildSpawnAgentParams({
            exposeSpawnAgentModelOverrides: false,
            hideSpawnAgentMetadata: false,
            roles: {},
        }) as { properties: Record<string, unknown> }
        assert.ok(!('agent_type' in schema.properties))
    })

    it('uses strict bounded model-visible schemas', () => {
        const schema = buildSpawnAgentParams({
            exposeSpawnAgentModelOverrides: true,
            hideSpawnAgentMetadata: false,
            roles: {},
        }) as unknown as {
            additionalProperties: boolean
            properties: Record<string, any>
        }
        assert.equal(schema.additionalProperties, false)
        assert.equal(schema.properties.task_name.pattern, '^[a-z0-9_]+$')
        assert.equal(schema.properties.message.minLength, 1)
        assert.equal(schema.properties.target, undefined)
        assert.equal(schema.properties.model.pattern, '^[^/\\s]+/[^/\\s]+$')
        assert.equal(schema.properties.reasoning_effort.anyOf.length, 7)
        assert.equal(schema.properties.fork_turns.anyOf.length, 3)
        const wait = buildWaitAgentParams({
            wait: { minTimeoutMs: 10, defaultTimeoutMs: 20, maxTimeoutMs: 30 },
        }) as unknown as {
            properties: {
                timeout_ms: { type: string; minimum: number; maximum: number }
            }
        }
        assert.equal(wait.properties.timeout_ms.type, 'integer')
        assert.equal(wait.properties.timeout_ms.minimum, 10)
        assert.equal(wait.properties.timeout_ms.maximum, 30)
    })

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
