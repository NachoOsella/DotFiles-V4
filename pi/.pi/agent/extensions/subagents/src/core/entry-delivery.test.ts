import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    VERSION,
} from '@earendil-works/pi-coding-agent'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import subagentsExtension from '../../index.ts'
import { isSupportedHostVersion } from '../config/host-compatibility.ts'

const nativeTest = isSupportedHostVersion(VERSION) ? test : test.skip
import {
    findLatestState,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from '../persistence/session-state.ts'
import { SUBAGENTS_COMMUNICATION_CUSTOM_TYPE } from './transport.ts'

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

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'native receipt did not settle')
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
}

nativeTest(
    'root receipts prove insertion, not dispatch or model completion',
    async (t) => {
        const directory = mkdtempSync(
            join(tmpdir(), 'subagents-entry-delivery-')
        )
        const manager = SessionManager.create(
            directory,
            join(directory, 'sessions')
        )
        manager.appendMessage({
            role: 'user',
            content: 'Review the project.',
            timestamp: Date.now(),
        })
        const communicationId = 'pending-native-root-result'
        manager.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, {
            version: 2,
            rootSessionId: manager.getSessionId(),
            persistedAt: Date.now(),
            agents: [
                {
                    id: 'reviewer-id',
                    path: '/root/reviewer',
                    parentPath: '/root',
                    rootSessionId: manager.getSessionId(),
                    model: { provider: MODEL.provider, id: MODEL.id },
                    activeTools: [],
                    status: 'Completed',
                    statusMessage: 'Review complete.',
                    createdAt: Date.now(),
                    lastActivityAt: Date.now(),
                    runSequence: 1,
                    pendingCompletions: [
                        {
                            communicationId,
                            runSequence: 1,
                            author: '/root/reviewer',
                            recipient: '/root',
                            payload: 'Review complete.',
                        },
                    ],
                },
            ],
        })
        const settingsManager = SettingsManager.inMemory({
            retry: { enabled: false },
        })
        const resourceLoader = new DefaultResourceLoader({
            cwd: directory,
            agentDir: directory,
            settingsManager,
            noExtensions: true,
            noThemes: true,
            extensionFactories: [
                subagentsExtension,
                (pi) => {
                    pi.on('before_agent_start', (event) => {
                        event.systemPromptOptions.sections.neighbor =
                            'Unrelated extension instruction.'
                    })
                },
            ],
        })
        await resourceLoader.reload()
        assert.deepEqual(resourceLoader.getExtensions().errors, [])
        const { session } = await createAgentSession({
            cwd: directory,
            agentDir: directory,
            settingsManager,
            resourceLoader,
            sessionManager: manager,
            model: MODEL,
            modelRuntime: {
                getAuth: async () => ({ auth: { apiKey: 'test' } }),
                hasConfiguredAuth: () => true,
                checkAuth: async () => undefined,
                isUsingOAuth: () => false,
                getModel: () => MODEL,
                getPhysicalModel: () => MODEL,
            } as unknown as ModelRuntime,
            tools: ['list_agents'],
        })
        let finishResponse: (() => void) | undefined
        t.after(async () => {
            try {
                finishResponse?.()
                await session.waitForIdle()
                await session.extensionRunner.emit({
                    type: 'session_shutdown',
                    reason: 'quit',
                })
            } finally {
                session.dispose()
                rmSync(directory, { recursive: true, force: true })
            }
        })
        let requests = 0
        const systemSections: Record<string, string | null> = {}
        session.agent.streamFunction = (_model, context) => {
            requests += 1
            for (const message of context.messages) {
                if (message.role === 'system') {
                    Object.assign(systemSections, message.sections)
                }
            }
            const stream = createAssistantMessageEventStream()
            const message: AssistantMessage = {
                role: 'assistant',
                content: [{ type: 'text', text: 'Result received.' }],
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
            }
            finishResponse = () =>
                stream.push({ type: 'done', reason: 'stop', message })
            return stream
        }
        const originalSend = session.sendCustomMessage.bind(session)
        let attempts = 0
        session.sendCustomMessage = async (message, options) => {
            if (message.customType === SUBAGENTS_COMMUNICATION_CUSTOM_TYPE) {
                attempts += 1
                if (attempts === 1)
                    throw new Error('simulated native insertion failure')
            }
            await originalSend(message, options)
        }
        const errors: string[] = []
        await session.bindExtensions({
            onError: (error) => errors.push(error.error),
        })
        await until(() => errors.length === 1)
        assert.match(errors[0]!, /simulated native insertion failure/)
        assert.equal(attempts, 1)
        assert.equal(requests, 0)
        assert.equal(
            findLatestState(manager.getBranch())?.agents[0]
                ?.lastDeliveredRunSequence,
            undefined
        )
        assert.equal(
            findLatestState(manager.getBranch())?.agents[0]?.pendingCompletions
                ?.length,
            1
        )

        await session.extensionRunner.emit({ type: 'agent_settled' })
        await until(
            () =>
                requests === 1 &&
                findLatestState(manager.getBranch())?.agents[0]
                    ?.lastDeliveredRunSequence === 1
        )
        assert.equal(session.isStreaming, true)
        assert.equal(session.getLastAssistantText(), undefined)
        const envelopes = manager
            .getBranch()
            .filter(
                (entry) =>
                    entry.type === 'custom_message' &&
                    entry.customType === SUBAGENTS_COMMUNICATION_CUSTOM_TYPE &&
                    (entry.details as { id?: string })?.id === communicationId
            )
        assert.equal(envelopes.length, 1)
        assert.equal(attempts, 2)
        assert.equal(requests, 1)
        assert.equal(
            findLatestState(manager.getBranch())?.agents[0]?.pendingCompletions
                ?.length,
            0
        )
        const queuedId = 'native-queued-context'
        const queuedEnvelopes = () =>
            manager
                .getBranch()
                .filter(
                    (entry) =>
                        entry.type === 'custom_message' &&
                        (entry.details as { id?: string })?.id === queuedId
                )
        await session.sendCustomMessage(
            {
                customType: 'native-steer-characterization',
                content: 'Context queued while the parent is streaming.',
                display: false,
                details: { id: queuedId },
            },
            { triggerTurn: true, deliverAs: 'steer' }
        )
        assert.equal(queuedEnvelopes().length, 0)
        assert.equal(requests, 1)
        assert.ok(finishResponse)
        finishResponse()
        await until(() => requests === 2)
        assert.equal(queuedEnvelopes().length, 1)
        assert.equal(session.isStreaming, true)
        finishResponse()
        await session.waitForIdle()
        assert.equal(queuedEnvelopes().length, 1)
        assert.equal(session.getLastAssistantText(), 'Result received.')

        const userRun = session.prompt('Verify the composed system prompt.')
        await until(() => requests === 3)
        assert.match(
            systemSections.neighbor ?? '',
            /Unrelated extension instruction\./
        )
        assert.match(
            systemSections.subagents ?? '',
            /You are \/root, the primary agent\./
        )
        assert.equal(
            systemSections.subagents?.match(/Collaboration contract:/g)?.length,
            1
        )
        finishResponse()
        await userRun
    }
)
