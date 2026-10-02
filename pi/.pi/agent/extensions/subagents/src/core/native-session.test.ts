import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Model } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
    createAgentSession,
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

        const modelRuntime = {
            getAuth: async () => ({ auth: { apiKey: 'test' } }),
            hasConfiguredAuth: () => true,
            checkAuth: async () => undefined,
            isUsingOAuth: () => false,
        } as unknown as ModelRuntime
        const { session } = await createAgentSession({
            model: MODEL,
            thinkingLevel: 'medium',
            sessionManager,
            settingsManager,
            cwd: '/repo',
            resourceLoader: loader,
            modelRuntime,
            tools: [],
        })
        let streamCalls = 0
        const streamedContexts: Context[] = []
        let finishStream!: () => void
        session.agent.streamFunction = (_model, context) => {
            streamCalls += 1
            streamedContexts.push(context)
            const stream = createAssistantMessageEventStream()
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
            queueMicrotask(() =>
                stream.push({ type: 'start', partial: message })
            )
            finishStream = () =>
                stream.push({ type: 'done', reason: 'stop', message })
            return stream
        }

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

        const run = session.sendCustomMessage(
            {
                customType: 'subagents-v3:communication',
                content: 'run',
                display: false,
                details: { triggerTurn: true },
            },
            { triggerTurn: true }
        )
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(streamCalls, 1)
        assert.equal(session.isStreaming, true)

        await session.sendCustomMessage(
            {
                customType: 'subagents-v3:communication',
                content: 'during-stream',
                display: false,
                details: { triggerTurn: false },
            },
            { triggerTurn: false }
        )
        assert.equal(
            session.messages.filter((message) => message.role === 'custom')
                .length,
            2,
            'queue-only input must remain deferred while streaming'
        )
        assert.equal(
            sessionManager
                .getEntries()
                .filter((entry) => entry.type === 'custom_message').length,
            2,
            'deferred input must not enter the session log mid-turn'
        )

        finishStream()
        await run
        assert.match(JSON.stringify(streamedContexts[0]?.messages), /queued/)
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
            3
        )
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
