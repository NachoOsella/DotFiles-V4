import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { makeAgentRuntime } from './agent-runtime.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import type { InterAgentCommunication } from '../domain/communication.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentPath } from '../domain/ids.ts'

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

async function createHarness(t: TestContext) {
    const directory = await mkdtemp(join(tmpdir(), 'subagents-runtime-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const lifecycle: string[] = []
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
            (pi) => {
                pi.on('session_start', () => {
                    lifecycle.push('start')
                })
                pi.on('session_shutdown', (_event, ctx) => {
                    // Finalizers must still have a valid context.
                    assert.equal(ctx.cwd, directory)
                    lifecycle.push('shutdown')
                })
            },
        ],
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(directory),
        model: MODEL,
        modelRuntime: {
            getAuth: async () => ({ auth: { apiKey: 'test' } }),
            hasConfiguredAuth: () => true,
            checkAuth: async () => undefined,
            isUsingOAuth: () => false,
            getModel: () => MODEL,
            getPhysicalModel: () => MODEL,
        } as unknown as ModelRuntime,
        tools: [],
    })
    await session.bindExtensions({})
    const completions: InterAgentCommunication[] = []
    const runtime = makeAgentRuntime({
        path: '/root/worker' as AgentPath,
        session,
    })
    const coordinator = new SubagentCoordinator({
        config: DEFAULT_SUBAGENTS_CONFIG,
        getRootSnapshot: () => ({
            path: ROOT_PATH,
            cwd: directory,
            model: MODEL,
            thinkingLevel: 'medium',
            activeTools: [],
            contextEntries: [],
            sessionId: 'root-session',
        }),
        rootEndpoint: {
            path: ROOT_PATH,
            send: async (comm) => {
                completions.push(comm)
            },
        },
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        sessionFactory: {
            create: async () => runtime,
            open: async () => runtime,
        },
    })
    t.after(() => coordinator.shutdown())

    function respond(stopReason: 'stop' | 'error' | 'aborted') {
        session.agent.streamFunction = () => {
            const stream = createAssistantMessageEventStream()
            const message: AssistantMessage = {
                role: 'assistant',
                content:
                    stopReason === 'stop'
                        ? [{ type: 'text', text: 'Recovered.' }]
                        : [],
                api: MODEL.api,
                provider: MODEL.provider,
                model: MODEL.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason,
                ...(stopReason === 'error'
                    ? { errorMessage: 'HTTP 401 invalid credential' }
                    : {}),
                timestamp: Date.now(),
            }
            queueMicrotask(() => {
                if (stopReason === 'stop')
                    stream.push({ type: 'done', reason: 'stop', message })
                else
                    stream.push({
                        type: 'error',
                        reason: stopReason,
                        error: message,
                    })
            })
            return stream
        }
    }

    async function spawn() {
        await coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'Test',
            forkTurns: 'none',
        })
        await runtime.currentRun
    }
    return {
        coordinator,
        session,
        runtime,
        completions,
        lifecycle,
        respond,
        spawn,
    }
}

test('native provider failures report an error and a later followup can recover', async (t) => {
    const harness = await createHarness(t)
    harness.respond('error')
    await harness.spawn()
    assert.equal(harness.coordinator.list(ROOT_PATH)[0]?.status, 'Errored')
    assert.equal(harness.completions[0]?.meta?.failed, true)
    assert.match(
        harness.completions[0]?.payload ?? '',
        /HTTP 401 invalid credential/
    )

    harness.respond('stop')
    await harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/worker',
        message: 'Retry',
    })
    await harness.runtime.currentRun
    assert.equal(
        harness.coordinator.list(ROOT_PATH)[0]?.status,
        'Completed',
        JSON.stringify(harness.completions)
    )
    assert.equal(harness.completions[1]?.payload, 'Recovered.')
    assert.equal(harness.completions[1]?.meta?.failed, undefined)
})

test('native aborted responses interrupt the child without a success completion', async (t) => {
    const harness = await createHarness(t)
    harness.respond('aborted')
    await harness.spawn()
    assert.equal(harness.coordinator.list(ROOT_PATH)[0]?.status, 'Interrupted')
    assert.deepEqual(harness.completions, [])
})

test('runtime disposal finalizes child extensions once before invalidating the session', async (t) => {
    const harness = await createHarness(t)
    await Promise.all([harness.runtime.dispose(), harness.runtime.dispose()])
    assert.deepEqual(harness.lifecycle, ['start', 'shutdown'])
})
