import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    clampWaitTimeout,
    decodeConfig,
    DEFAULT_SUBAGENTS_CONFIG,
} from './config.ts'
import { modeInstructions, resolveConfiguredMode, resolveMode } from './mode.ts'
import {
    assembleChildPrompt,
    assembleRootPrompt,
    COLLABORATION_TOOL_PROMPTS,
    rootRoleInstructions,
    subagentRoleInstructions,
} from './prompts.ts'
import {
    buildSpawnAgentParams,
    buildWaitAgentParams,
    plannedToolNames,
} from '../tools/tool-specs.ts'

describe('config', () => {
    it('decodes current defaults and validates wait ordering', () => {
        assert.deepEqual(decodeConfig(undefined), DEFAULT_SUBAGENTS_CONFIG)
        assert.deepEqual(DEFAULT_SUBAGENTS_CONFIG.wait, {
            defaultTimeoutMs: 30_000,
            minTimeoutMs: 10_000,
            maxTimeoutMs: 3_600_000,
        })
        assert.throws(() =>
            decodeConfig({
                wait: { minTimeoutMs: 5_000, defaultTimeoutMs: 1_000 },
            })
        )
        assert.throws(() => decodeConfig({ maxConcurrentExecutions: 0 }))
    })

    it('ignores removed legacy keys', () => {
        const decoded = decodeConfig({
            maxConcurrentAgents: 2,
            maxResidentAgents: 3,
            minWaitTimeoutMs: 5_000,
            defaultWaitTimeoutMs: 1_000,
            maxWaitTimeoutMs: 300,
        })
        assert.equal(decoded.maxConcurrentExecutions, 4)
        assert.equal(decoded.maxLoadedAgents, 16)
        assert.deepEqual(decoded.wait, DEFAULT_SUBAGENTS_CONFIG.wait)

        const canonical = decodeConfig({
            maxConcurrentExecutions: 2,
            maxLoadedAgents: 8,
        })
        assert.equal(canonical.maxConcurrentExecutions, 2)
        assert.equal(canonical.maxLoadedAgents, 8)
    })

    it('clamps below-minimum waits and rejects above-maximum', () => {
        const clamped = clampWaitTimeout(DEFAULT_SUBAGENTS_CONFIG, 1)
        assert.equal(
            clamped.effectiveMs,
            DEFAULT_SUBAGENTS_CONFIG.wait.minTimeoutMs
        )
        assert.ok(clamped.note)
        assert.equal(clamped.rejected, null)

        const rejected = clampWaitTimeout(
            DEFAULT_SUBAGENTS_CONFIG,
            DEFAULT_SUBAGENTS_CONFIG.wait.maxTimeoutMs + 1
        )
        assert.ok(rejected.rejected)

        const normal = clampWaitTimeout(DEFAULT_SUBAGENTS_CONFIG, undefined)
        assert.equal(
            normal.effectiveMs,
            DEFAULT_SUBAGENTS_CONFIG.wait.defaultTimeoutMs
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

    it('covers the required meaning clauses once', () => {
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
            'spawn message brief',
            'RESULT (outcome)',
        ]) {
            assert.ok(root.includes(clause), `root prompt misses: ${clause}`)
        }
        assert.equal(
            root.match(/model and reasoning_effort overrides/g)?.length,
            1
        )
        assert.equal(
            root.match(/Wait for agent activity|wait_agent returns/g)?.length,
            1
        )
        const child = assembleChildPrompt(input)
        assert.ok(child.includes('FINAL_ANSWER'))
        assert.ok(!child.includes('/root, the primary'))
        assert.match(child, /You can spawn agents/)
    })

    it('keeps small work local in every mode', () => {
        for (const mode of [
            resolveMode({ ultraReasoning: false }),
            resolveMode({ ultraReasoning: true }),
        ]) {
            assert.match(
                assembleRootPrompt({ ...input, mode }),
                /Keep work that needs one or two local calls/
            )
        }
        const proactive = modeInstructions({ _tag: 'Proactive' }) ?? ''
        assert.match(proactive, /but only for independent work/)
        assert.ok(
            proactive.indexOf('but only for independent work') <
                proactive.indexOf('When you do delegate')
        )
    })

    it('does not recommend spawning at the depth limit', () => {
        const limited = assembleChildPrompt({
            ...input,
            config: { ...DEFAULT_SUBAGENTS_CONFIG, maxDepth: 1 },
            currentDepth: 1,
        })
        assert.match(
            limited,
            /Nested delegation is unavailable at depth 1 of 1/
        )
        assert.ok(!limited.includes('spawn_agent'))

        const nested = assembleChildPrompt({
            ...input,
            config: { ...DEFAULT_SUBAGENTS_CONFIG, maxDepth: 2 },
            currentDepth: 0,
        })
        assert.match(nested, /You can spawn agents/)
        assert.match(nested, /paths up to depth 2/)
    })

    it('shows configured role descriptions to the model', () => {
        const config = {
            ...DEFAULT_SUBAGENTS_CONFIG,
            roles: {
                reviewer: { description: 'Read-only code review' },
                builder: {},
            },
        }
        const root = assembleRootPrompt({ ...input, config })
        assert.match(root, /reviewer \(Read-only code review\)/)
        assert.match(root, /builder/)
        assert.match(root, /Omit agent_type for the default role/)

        const hidden = assembleRootPrompt({
            ...input,
            config: { ...config, hideSpawnAgentMetadata: true },
        })
        assert.ok(!hidden.includes('reviewer'))
    })

    it('states the override policy for the exposed capability', () => {
        const exposed = assembleRootPrompt(input)
        assert.match(
            exposed,
            /overrides require fork_turns none or a positive N/
        )
        const inherited = assembleRootPrompt({
            ...input,
            config: {
                ...DEFAULT_SUBAGENTS_CONFIG,
                exposeSpawnAgentModelOverrides: false,
            },
        })
        assert.match(inherited, /inherit the parent model/)
        assert.ok(!inherited.includes('require fork_turns'))
    })

    it('appends configured hints without replacing the contract', () => {
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
        assert.ok(assembled.includes('Collaboration contract'))
    })

    it('applies developer instructions to children only', () => {
        const config = {
            ...DEFAULT_SUBAGENTS_CONFIG,
            subagentDeveloperInstructions: 'child-only rule',
        }
        assert.ok(
            assembleChildPrompt({ ...input, config }).includes(
                'child-only rule'
            )
        )
        assert.ok(
            !assembleRootPrompt({ ...input, config }).includes(
                'child-only rule'
            )
        )
    })

    it('conditions wait guidance on tool exposure', () => {
        const withoutWait = assembleRootPrompt({
            ...input,
            config: { ...DEFAULT_SUBAGENTS_CONFIG, waitAgentEnabled: false },
        })
        assert.ok(!withoutWait.includes('wait_agent'))
        const withWait = assembleRootPrompt(input)
        assert.match(withWait, /wait_agent returns when mail arrives/)
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
        assert.match(schema.properties.message.description, /objective/)
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

    it('exposes the exact collaboration tool family for each wait setting', () => {
        assert.deepEqual(plannedToolNames(true), [
            'spawn_agent',
            'send_message',
            'followup_task',
            'wait_agent',
            'interrupt_agent',
            'list_agents',
        ])
        assert.deepEqual(plannedToolNames(false), [
            'spawn_agent',
            'send_message',
            'followup_task',
            'interrupt_agent',
            'list_agents',
        ])
    })

    it('keeps tool copy free of repeated contract rules', () => {
        const guidelines = Object.values(COLLABORATION_TOOL_PROMPTS).flatMap(
            (tool) => tool.promptGuidelines
        )
        assert.ok(
            !guidelines.some((guideline) => /fork_turns/.test(guideline)),
            'fork_turns belongs to the contract'
        )
        assert.ok(
            !guidelines.some((guideline) => /keep small work/i.test(guideline)),
            'local-work rule belongs to the contract'
        )
    })

    it('describes message success as dispatch acceptance, not insertion', () => {
        const guideline =
            COLLABORATION_TOOL_PROMPTS.send_message.promptGuidelines.join(' ')
        assert.match(guideline, /accepted the message for dispatch/)
        assert.match(guideline, /not proof of transcript insertion/)
        assert.match(guideline, /not proof of .*processing/)
        assert.doesNotMatch(guideline, /message was inserted/)
    })
})
