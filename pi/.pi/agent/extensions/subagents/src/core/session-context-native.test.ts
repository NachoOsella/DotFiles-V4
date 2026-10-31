import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context, Model } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { VERSION } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import type { AgentPath } from '../domain/ids.ts'
import {
    TOOL_FOLLOWUP_TASK,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
    TOOL_SEND_MESSAGE,
    TOOL_SPAWN_AGENT,
    TOOL_WAIT_AGENT,
} from '../tools/tool-specs.ts'
import { SessionFactory } from './session-factory.ts'

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
        parameters: { type: 'object', properties: {} },
        execute: async () => ({
            content: [{ type: 'text' as const, text: name }],
        }),
    }
}

function record(): AgentRecord {
    return {
        id: 'agent-1' as AgentRecord['id'],
        path: '/root/child' as AgentPath,
        parentId: 'root' as AgentRecord['id'],
        parentPath: '/root' as AgentPath,
        status: AgentStatus.pendingInit(),
        residency: 'loading',
        role: 'reviewer',
        model: 'test-provider/test-model',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        activeTools: ['read'],
    }
}

function parent(): ParentExecutionSnapshot {
    return {
        path: '/root' as AgentPath,
        cwd: '/repo',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium',
        activeTools: ['read'],
        contextEntries: [],
        sessionId: 'root-session',
    }
}

function stream() {
    const result = createAssistantMessageEventStream()
    const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'done' }],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
    }
    queueMicrotask(() => result.push({ type: 'start', partial: message }))
    queueMicrotask(() => result.push({ type: 'done', reason: 'stop', message }))
    return result
}

test('first child custom run prepares the child prompt on supported Pi and characterizes the Pi 1.0 gap', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-native-context-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const factory = new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => root,
        agentDir: join(root, 'agent'),
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => COLLABORATION_TOOLS.map(customTool),
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            roles: {
                reviewer: {
                    promptAppend: 'ROLE-PROMPT-MARKER',
                    tools: ['read'],
                },
            },
        },
    })
    const runtime = await factory.create(record(), parent(), { _tag: 'None' })
    const contexts: Context[] = []
    try {
        assert.match(
            runtime.session.systemPrompt,
            /Your agent path is \/root\/child/
        )
        assert.match(runtime.session.systemPrompt, /ROLE-PROMPT-MARKER/)
        const active = runtime.session.getActiveToolNames()
        for (const name of ['read', ...COLLABORATION_TOOLS]) {
            assert.ok(active.includes(name), `${name} should be active`)
        }

        runtime.session.agent.streamFunction = (_model, context) => {
            contexts.push(context)
            return stream()
        }
        await runtime.session.sendCustomMessage(
            {
                customType: 'subagents-v3:communication',
                content:
                    'Message Type: NEW_TASK\nTask name: child\nSender: /root\nPayload:\nfirst task',
                display: false,
                details: { payload: 'first task' },
            },
            { triggerTurn: true }
        )

        assert.equal(contexts.length, 1)
        const messages = contexts[0]?.messages ?? []
        const system = messages[0] as
            | {
                  role?: string
                  toolsAdded?: Array<{ name: string }>
                  sections?: unknown
              }
            | undefined
        assert.equal(system?.role, 'system')
        const declared = (system?.toolsAdded ?? []).map((tool) => tool.name)
        for (const name of ['read', ...COLLABORATION_TOOLS]) {
            assert.ok(declared.includes(name), `${name} should be declared`)
        }
        assert.match(JSON.stringify(messages), /first task/)

        // The extension supports Pi >= 1.4. Host 1.4 prepares prompt sections
        // before a custom-triggered run; Pi 1.0.0 bypasses that preparation, so
        // the same request has tools but no system prompt. Assert the supported
        // guarantee on 1.4+ and keep the old behavior explicit on 1.0.
        const [major, minor] = VERSION.split('.').map(Number)
        const preparesCustomRuns =
            Number.isFinite(major) &&
            Number.isFinite(minor) &&
            (major > 1 || (major === 1 && minor >= 4))
        const sections = system?.sections
        if (preparesCustomRuns) {
            assert.ok(
                sections !== undefined,
                `Pi ${VERSION} must prepare prompt sections for a custom-triggered run`
            )
            const serialized = JSON.stringify(sections)
            assert.match(serialized, /Your agent path is \/root\/child/)
            assert.match(serialized, /ROLE-PROMPT-MARKER/)
        } else {
            assert.equal(
                sections,
                undefined,
                `Pi ${VERSION} first idle custom run bypasses prompt preparation`
            )
            // The session still exposes the intended prompt; only this host's
            // first custom-triggered request omits it.
            assert.match(
                runtime.session.systemPrompt,
                /Your agent path is \/root\/child/
            )
        }
    } finally {
        await runtime.dispose()
    }
})
