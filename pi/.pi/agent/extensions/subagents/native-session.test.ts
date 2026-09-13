import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
    AgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import assert from 'node:assert/strict'
import test from 'node:test'

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

test('AgentSession owns custom-message persistence and triggered turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'subagents-native-session-'))
    const sessionDir = join(root, 'sessions')
    const agentDir = join(root, 'agent')
    try {
        const sessionManager = SessionManager.create('/repo', sessionDir)
        const settingsManager = SettingsManager.create('/repo', agentDir)
        const loader = new DefaultResourceLoader({
            cwd: '/repo',
            agentDir,
            settingsManager,
            noThemes: true,
            extensionsOverride: (base) => ({
                ...base,
                extensions: [],
            }),
        })
        await loader.reload()

        let streamCalls = 0
        const agent = new Agent({
            initialState: {
                model: MODEL,
                thinkingLevel: 'medium',
                systemPrompt: 'test',
            },
            streamFn: () => {
                streamCalls += 1
                const stream = createAssistantMessageEventStream()
                queueMicrotask(() =>
                    stream.push({
                        type: 'done',
                        reason: 'stop',
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: 'done' }],
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
                            stopReason: 'stop',
                            timestamp: Date.now(),
                        },
                    })
                )
                return stream
            },
        })
        const modelRuntime = {
            getAuth: async () => ({ auth: { apiKey: 'test' } }),
            hasConfiguredAuth: () => true,
            checkAuth: async () => undefined,
            isUsingOAuth: () => false,
        } as unknown as ModelRuntime
        const session = new AgentSession({
            agent,
            sessionManager,
            settingsManager,
            cwd: '/repo',
            resourceLoader: loader,
            modelRuntime,
            initialActiveToolNames: [],
        })

        await session.sendCustomMessage(
            {
                customType: 'subagents-v3:communication',
                content: 'queued',
                display: false,
                details: { triggerTurn: false },
            },
            { triggerTurn: false }
        )
        assert.equal(streamCalls, 0)
        assert.equal(
            session.messages.filter((message) => message.role === 'custom')
                .length,
            1
        )

        await session.sendCustomMessage(
            {
                customType: 'subagents-v3:communication',
                content: 'run',
                display: false,
                details: { triggerTurn: true },
            },
            { triggerTurn: true }
        )
        assert.equal(streamCalls, 1)
        assert.ok(
            session.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    message.content.some(
                        (content) =>
                            content.type === 'text' && content.text === 'done'
                    )
            )
        )
        session.dispose()

        const reopened = SessionManager.open(
            session.sessionFile!,
            sessionDir,
            '/repo'
        )
        assert.equal(
            reopened
                .getEntries()
                .filter(
                    (entry) =>
                        entry.type === 'custom_message' &&
                        entry.customType === 'subagents-v3:communication'
                ).length,
            2
        )
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
