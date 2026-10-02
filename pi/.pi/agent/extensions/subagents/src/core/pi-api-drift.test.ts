/**
 * API drift guard.
 *
 * The extension reads a specific slice of Pi. Nothing here asserts Pi's own
 * behavior for its own sake: every check names a contract this extension relies
 * on, so a rename, a removal, or a semantic change fails the suite instead of
 * silently disabling a capability at runtime.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Type } from 'typebox'
import {
    createAgentSession,
    createCodemodeExtension,
    createToolSearchExtension,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    sessionEntryToContextMessages,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type {
    AgentSession,
    InlineExtension,
} from '@earendil-works/pi-coding-agent'

const cwd = '/tmp/pi-api-drift'
const agentDir = mkdtempSync(join(tmpdir(), 'subagents-drift-agent-'))

async function createSession(
    factories: InlineExtension[] = [],
    tools: string[] = []
) {
    const settingsManager = SettingsManager.create(cwd, agentDir)
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noThemes: true,
        noExtensions: true,
        extensionFactories: factories,
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        tools,
    })
    return session
}

function probeExtension(starts: number[]): InlineExtension {
    const probe = (name: string, exposure?: 'model-only') => ({
        name,
        label: name,
        description: 'drift probe',
        parameters: Type.Object({}),
        ...(exposure ? { exposure } : {}),
        async execute() {
            return {
                content: [{ type: 'text' as const, text: '{}' }],
                details: {},
                structuredContent: { ok: true },
            }
        },
    })
    return {
        name: 'drift-probe',
        factory: (pi) => {
            pi.registerTool(probe('probe_direct'))
            pi.registerTool(probe('probe_model_only', 'model-only'))
            pi.on('session_start', () => {
                starts.push(1)
            })
        },
    }
}

test('the pi entry points this extension imports are still exported', () => {
    for (const [name, value] of Object.entries({
        createAgentSession,
        createCodemodeExtension,
        createToolSearchExtension,
        DefaultResourceLoader,
        getAgentDir,
        SessionManager,
        sessionEntryToContextMessages,
        SettingsManager,
    })) {
        assert.equal(typeof value, 'function', `${name} is not exported`)
    }
})

test('AgentSession keeps the surface the coordinator reads', async () => {
    const session = await createSession()
    try {
        for (const method of [
            'bindExtensions',
            'getSessionStats',
            'getActiveToolNames',
            'getCallableToolNames',
            'getAllTools',
            'sendCustomMessage',
            'abort',
            'dispose',
            'subscribe',
        ]) {
            assert.equal(
                typeof (session as unknown as Record<string, unknown>)[method],
                'function',
                `session.${method} is missing`
            )
        }
        assert.equal(typeof session.isStreaming, 'boolean')
        assert.ok(Array.isArray(session.sessionManager.buildContextEntries()))
        assert.ok(Array.isArray(session.sessionManager.getEntries()))
        // Usage attribution reads the physical model behind a virtual selection.
        assert.ok('routedModel' in session)

        const stats = session.getSessionStats()
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
            assert.equal(
                typeof stats.tokens[key as keyof typeof stats.tokens],
                'number',
                `stats.tokens.${key} is missing`
            )
        }
        for (const key of [
            'cost',
            'userMessages',
            'assistantMessages',
            'toolResults',
        ]) {
            assert.equal(
                typeof stats[key as keyof typeof stats],
                'number',
                `stats.${key} is missing`
            )
        }
    } finally {
        session.dispose()
    }
})

test('tool exposure and session_start keep the semantics the factory relies on', async () => {
    const starts: number[] = []
    const session: AgentSession = await createSession(
        [probeExtension(starts)],
        ['probe_direct', 'probe_model_only']
    )
    try {
        const tools = session.getAllTools()
        assert.equal(
            tools.find((tool) => tool.name === 'probe_model_only')?.exposure,
            'model-only'
        )
        assert.equal(
            tools.find((tool) => tool.name === 'probe_direct')?.exposure,
            'direct'
        )
        // Both exposures are declared to the model. Only the direct one is
        // callable from another tool, which is what keeps codemode out of
        // scripts while it stays reachable by the model.
        const active = session.getActiveToolNames()
        assert.ok(active.includes('probe_direct'))
        assert.ok(active.includes('probe_model_only'))
        const callable = session.getCallableToolNames()
        assert.ok(callable.includes('probe_direct'))
        assert.ok(!callable.includes('probe_model_only'))

        assert.equal(starts.length, 0)
        await session.bindExtensions({})
        assert.equal(starts.length, 1, 'bindExtensions must emit session_start')
    } finally {
        session.dispose()
    }
})

test('session entries still convert into fork context', () => {
    const manager = SessionManager.inMemory(cwd)
    manager.appendMessage({
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
    })
    const entry = manager.getEntries().find((item) => item.type === 'message')
    assert.ok(entry)
    const messages = sessionEntryToContextMessages(entry)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
})
