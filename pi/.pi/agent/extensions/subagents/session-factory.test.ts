import assert from 'node:assert/strict'
import test from 'node:test'
import { Type } from 'typebox'
import type { Model } from '@earendil-works/pi-ai'
import { DEFAULT_SUBAGENTS_CONFIG } from './src/config.ts'
import type { AgentRecord } from './src/agent-record.ts'
import { AgentStatus } from './src/agent-status.ts'
import type { ParentExecutionSnapshot } from './src/parent-snapshot.ts'
import type { AgentPath } from './src/ids.ts'
import { SessionFactory } from './src/session-factory.ts'
import {
    TOOL_FOLLOWUP_TASK,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
    TOOL_SEND_MESSAGE,
    TOOL_SPAWN_AGENT,
    TOOL_WAIT_AGENT,
} from './src/tool-specs.ts'

const MODEL: Model<'test-api'> = {
    id: 'test-model',
    name: 'Test model',
    api: 'test-api',
    provider: 'test-provider',
    baseUrl: 'http://test.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
}

const COLLABORATION_TOOLS = [
    TOOL_SPAWN_AGENT,
    TOOL_SEND_MESSAGE,
    TOOL_FOLLOWUP_TASK,
    TOOL_WAIT_AGENT,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
]

function customTool(name: string) {
    return {
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => ({
            content: [{ type: 'text' as const, text: name }],
        }),
    }
}

function record(path: string, activeTools: readonly string[]): AgentRecord {
    return {
        id: 'agent-1' as AgentRecord['id'],
        path: path as AgentPath,
        parentId: 'root' as AgentRecord['id'],
        parentPath: '/root' as AgentPath,
        status: AgentStatus.pendingInit(),
        residency: 'loading',
        model: 'test-provider/test-model',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        activeTools,
    }
}

function parent(activeTools: readonly string[]): ParentExecutionSnapshot {
    return {
        path: '/root' as AgentPath,
        cwd: '/tmp/subagents-session-factory-test',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium',
        activeTools,
        contextEntries: [],
        sessionId: 'root-session',
    }
}

function createFactory(
    overrides: Partial<typeof DEFAULT_SUBAGENTS_CONFIG> = {}
) {
    const config = { ...DEFAULT_SUBAGENTS_CONFIG, ...overrides }
    return new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => COLLABORATION_TOOLS.map(customTool),
        config,
    })
}

async function activeTools(
    factory: SessionFactory,
    child: AgentRecord,
    parentSnapshot: ParentExecutionSnapshot
) {
    const runtime = await factory.create(child, parentSnapshot, {
        _tag: 'None',
    })
    try {
        return {
            active: runtime.session.getActiveToolNames(),
            configured: runtime.session.getAllTools().map((tool) => tool.name),
        }
    } finally {
        await runtime.dispose()
    }
}

test('child sessions retain inherited tools and activate permitted collaboration tools', async () => {
    const result = await activeTools(
        createFactory(),
        record('/root/child', ['read', 'bash']),
        parent(['read', 'bash'])
    )

    for (const name of ['read', 'bash', ...COLLABORATION_TOOLS]) {
        assert.ok(result.active.includes(name), `${name} should be active`)
        assert.ok(
            result.configured.includes(name),
            `${name} should be configured`
        )
    }
})

test('children at the nesting limit cannot receive spawn_agent', async () => {
    const inherited = ['read', 'bash', ...COLLABORATION_TOOLS]
    const result = await activeTools(
        createFactory({ maxDepth: 0 }),
        record('/root/child', inherited),
        parent(inherited)
    )

    assert.ok(result.active.includes('read'))
    assert.ok(result.active.includes('bash'))
    assert.ok(!result.active.includes(TOOL_SPAWN_AGENT))
    assert.ok(!result.configured.includes(TOOL_SPAWN_AGENT))
    for (const name of [
        TOOL_SEND_MESSAGE,
        TOOL_FOLLOWUP_TASK,
        TOOL_WAIT_AGENT,
        TOOL_INTERRUPT_AGENT,
        TOOL_LIST_AGENTS,
    ]) {
        assert.ok(result.active.includes(name), `${name} should remain active`)
    }
})

test('children omit wait_agent when wait is disabled', async () => {
    const inherited = ['read', 'bash', ...COLLABORATION_TOOLS]
    const result = await activeTools(
        createFactory({ waitAgentEnabled: false }),
        record('/root/child', inherited),
        parent(inherited)
    )

    assert.ok(result.active.includes(TOOL_SPAWN_AGENT))
    assert.ok(!result.active.includes(TOOL_WAIT_AGENT))
    assert.ok(!result.configured.includes(TOOL_WAIT_AGENT))
    for (const name of [
        TOOL_SEND_MESSAGE,
        TOOL_FOLLOWUP_TASK,
        TOOL_INTERRUPT_AGENT,
        TOOL_LIST_AGENTS,
    ]) {
        assert.ok(result.active.includes(name), `${name} should remain active`)
    }
})
