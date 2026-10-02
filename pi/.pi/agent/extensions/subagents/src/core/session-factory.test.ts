import assert from 'node:assert/strict'
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
    readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Type } from 'typebox'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import type { AgentPath } from '../domain/ids.ts'
import { SessionFactory } from './session-factory.ts'
import {
    TOOL_FOLLOWUP_TASK,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
    TOOL_SEND_MESSAGE,
    TOOL_SPAWN_AGENT,
    TOOL_WAIT_AGENT,
} from '../tools/tool-specs.ts'

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
        // Isolate child sessions from the developer's own agent directory, so
        // tests never load real extensions or settings.
        agentDir: mkdtempSync(join(tmpdir(), 'subagents-factory-agent-')),
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

test('children inherit codemode and tool search as registered built-ins', async () => {
    const inherited = ['read', 'bash', 'codemode', 'tool_search']
    const result = await activeTools(
        createFactory(),
        record('/root/child', inherited),
        parent(inherited)
    )

    for (const name of inherited) {
        assert.ok(result.active.includes(name), `${name} should be active`)
        assert.ok(
            result.configured.includes(name),
            `${name} should be configured`
        )
    }
})

test('children do not receive codemode when the parent never had it', async () => {
    const result = await activeTools(
        createFactory(),
        record('/root/child', ['read']),
        parent(['read'])
    )

    assert.ok(!result.active.includes('codemode'))
    assert.ok(!result.configured.includes('codemode'))
    assert.ok(!result.configured.includes('tool_search'))
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

test('forked history contributes no billable usage, including after reopening', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-fork-usage-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const agentDir = join(directory, 'agent')
    const factory = new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => directory,
        agentDir,
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        config: DEFAULT_SUBAGENTS_CONFIG,
    })
    const source = SessionManager.inMemory('/repo')
    const inherited: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Inherited context' }],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: {
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 5,
            cacheWrite1h: 5,
            reasoning: 10,
            totalTokens: 135,
            cost: {
                input: 1,
                output: 1,
                cacheRead: 1,
                cacheWrite: 1,
                total: 4,
            },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
    }
    source.appendMessage(inherited)
    const snapshot = { ...parent([]), contextEntries: source.getBranch() }
    for (const fork of [
        { _tag: 'All' } as const,
        { _tag: 'LastN', turns: 1 } as const,
    ]) {
        const child = record('/root/child', [])
        const runtime = await factory.create(child, snapshot, fork)
        try {
            assert.equal(runtime.session.getSessionStats().cost, 0)
            assert.equal(runtime.session.getSessionStats().tokens.total, 0)
            assert.match(
                JSON.stringify(runtime.session.messages),
                /Inherited context/
            )
            runtime.session.sessionManager.appendMessage({
                ...inherited,
                content: [{ type: 'text', text: 'Child response' }],
                usage: {
                    input: 7,
                    output: 3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 10,
                    cost: {
                        input: 0.1,
                        output: 0.2,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0.3,
                    },
                },
            })
            const sessionFile = runtime.session.sessionFile!
            await runtime.dispose()
            const reopened = await factory.open({ ...child, sessionFile })
            try {
                assert.equal(reopened.session.getSessionStats().cost, 0.3)
                assert.equal(
                    reopened.session.getSessionStats().tokens.total,
                    10
                )
            } finally {
                await reopened.dispose()
            }
        } finally {
            await runtime.dispose()
        }
    }
    assert.equal(inherited.usage.cost.total, 4)
    assert.equal(inherited.usage.totalTokens, 135)
})

test('factory-started extensions finalize when a child is disposed', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-finalizers-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const extensions = join(directory, 'extensions')
    mkdirSync(extensions)
    const log = join(directory, 'lifecycle.log')
    writeFileSync(
        join(extensions, 'probe.ts'),
        `
        import { appendFileSync } from 'node:fs'
        export default function(pi) {
            pi.on('session_start', () => appendFileSync(${JSON.stringify(log)}, 'start\\n'))
            pi.on('session_shutdown', () => appendFileSync(${JSON.stringify(log)}, 'shutdown\\n'))
        }
    `
    )
    const factory = new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        agentDir: directory,
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        config: DEFAULT_SUBAGENTS_CONFIG,
    })
    const runtime = await factory.create(
        record('/root/child', []),
        parent([]),
        { _tag: 'None' }
    )
    await Promise.all([runtime.dispose(), runtime.dispose()])
    assert.equal(readFileSync(log, 'utf8'), 'start\nshutdown\n')
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
