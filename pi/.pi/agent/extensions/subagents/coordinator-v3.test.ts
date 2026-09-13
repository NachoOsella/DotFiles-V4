import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from './src/config.ts'
import { SubagentCoordinator } from './src/coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './src/agent-runtime.ts'
import type { AgentPath } from './src/ids.ts'
import type { InterAgentCommunication } from './src/communication.ts'
import type { DeliveryOptions } from './src/transport.ts'
import type { ParentExecutionSnapshot } from './src/parent-snapshot.ts'
import type { AgentRecord } from './src/agent-record.ts'
import type { SubagentSessionFactory } from './src/session-factory.ts'
import { ROOT_PATH } from './src/agent-path.ts'

class Deferred<T> {
    readonly promise: Promise<T>
    private resolvePromise!: (value: T) => void

    constructor() {
        this.promise = new Promise<T>((resolve) => {
            this.resolvePromise = resolve
        })
    }

    resolve(value: T): void {
        this.resolvePromise(value)
    }
}

class FakeSession {
    readonly sessionId: string
    readonly sessionFile: string
    readonly sessionManager = {
        getCwd: () => '/repo',
        buildContextEntries: () => [],
    }
    readonly model: { provider: string; id: string }
    readonly thinkingLevel: AgentRecord['thinkingLevel']
    readonly activeTools: string[]
    readonly customMessages: unknown[] = []
    readonly messages: unknown[] = []
    isStreaming = false
    runCalls = 0
    disposed = false
    private readonly runResolvers: Array<() => void> = []

    constructor(id: string, record: AgentRecord) {
        this.sessionId = `session-${id}`
        this.sessionFile = `/tmp/${id}.jsonl`
        const separator = record.model.indexOf('/')
        this.model = {
            provider: record.model.slice(0, separator),
            id: record.model.slice(separator + 1),
        }
        this.thinkingLevel = record.thinkingLevel ?? 'medium'
        this.activeTools = [...(record.activeTools ?? [])]
    }

    subscribe(): () => void {
        return () => undefined
    }

    async sendCustomMessage(
        message: unknown,
        options?: { triggerTurn?: boolean; deliverAs?: string }
    ): Promise<void> {
        this.customMessages.push({ message, options })
        const content = (message as { content?: unknown }).content
        this.messages.push({ role: 'custom', content })
        if (options?.triggerTurn && !this.isStreaming) {
            this.isStreaming = true
            this.runCalls += 1
            await new Promise<void>((resolve) => {
                this.runResolvers.push(() => {
                    this.isStreaming = false
                    resolve()
                })
            })
        }
    }

    finishRun(): void {
        this.runResolvers.shift()?.()
    }

    abort(): Promise<void> {
        this.finishRun()
        return Promise.resolve()
    }

    dispose(): void {
        this.disposed = true
    }

    getActiveToolNames(): string[] {
        return this.activeTools
    }

    getLastAssistantText(): string {
        return 'done'
    }

    getSessionStats() {
        return {
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            userMessages: 1,
            assistantMessages: this.runCalls,
            toolResults: 0,
        }
    }
}

interface Harness {
    readonly coordinator: SubagentCoordinator
    readonly sessions: Map<string, FakeSession>
    readonly opens: { count: number }
    readonly rootMessages: InterAgentCommunication[]
}

function createHarness(options?: {
    maxAgents?: number
    maxLoadedAgents?: number
    openGate?: Deferred<void>
    createGate?: Deferred<void>
    onCreateStarted?: () => void
    finalGate?: Deferred<void>
    onFinalStarted?: () => void
    roles?: typeof DEFAULT_SUBAGENTS_CONFIG.roles
}): Harness {
    const sessions = new Map<string, FakeSession>()
    const opens = { count: 0 }
    const rootMessages: InterAgentCommunication[] = []
    const rootSnapshot: ParentExecutionSnapshot = {
        path: ROOT_PATH,
        cwd: '/repo',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium',
        activeTools: ['spawn_agent', 'send_message', 'followup_task'],
        contextEntries: [],
        sessionId: 'root-session',
    }
    const makeRuntime = (record: AgentRecord): AgentRuntime => {
        const session = new FakeSession(
            record.path.replaceAll('/', '_'),
            record
        )
        sessions.set(record.path as string, session)
        return makeAgentRuntime({
            path: record.path,
            session: session as unknown as AgentSession,
            runSequence: record.runSequence,
        })
    }
    const factory: SubagentSessionFactory = {
        async create(record) {
            options?.onCreateStarted?.()
            if (options?.createGate) await options.createGate.promise
            return makeRuntime(record)
        },
        async open(record) {
            opens.count += 1
            if (options?.openGate) await options.openGate.promise
            return makeRuntime(record)
        },
    }
    const rootEndpoint = {
        path: ROOT_PATH,
        async send(
            communication: InterAgentCommunication,
            _options: DeliveryOptions
        ) {
            rootMessages.push(communication)
            if (communication.kind === 'result' && options?.finalGate) {
                options.onFinalStarted?.()
                await options.finalGate.promise
            }
        },
    }
    const config = {
        ...DEFAULT_SUBAGENTS_CONFIG,
        maxAgents: options?.maxAgents ?? DEFAULT_SUBAGENTS_CONFIG.maxAgents,
        maxLoadedAgents: options?.maxLoadedAgents ?? 16,
        roles: options?.roles ?? DEFAULT_SUBAGENTS_CONFIG.roles,
    }
    const coordinator = new SubagentCoordinator({
        config,
        getRootSnapshot: () => rootSnapshot,
        rootEndpoint,
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '/tmp/subagents',
        getModelRegistry: () => ({}) as never,
        buildTools: () => [],
        sessionFactory: factory,
    })
    return { coordinator, sessions, opens, rootMessages }
}

function restoreOne(
    coordinator: SubagentCoordinator,
    overrides: Partial<{
        runSequence: number
        lastDeliveredRunSequence: number
        status: string
    }> = {}
): void {
    coordinator.restore({
        version: 2,
        rootSessionId: 'root-session',
        persistedAt: Date.now(),
        agents: [
            {
                id: 'agent-a',
                path: '/root/a',
                parentPath: '/root',
                rootSessionId: 'root-session',
                sessionId: 'old-session',
                sessionFile: '/tmp/a.jsonl',
                cwd: '/repo',
                role: 'default',
                model: { provider: 'test-provider', id: 'test-model' },
                thinkingLevel: 'medium',
                activeTools: ['spawn_agent', 'send_message', 'followup_task'],
                status: overrides.status ?? 'Completed',
                statusMessage: 'done',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                runSequence: overrides.runSequence ?? 1,
                lastDeliveredRunSequence:
                    overrides.lastDeliveredRunSequence ?? 1,
            },
        ],
    })
}

test('concurrent spawns reserve registry capacity atomically', async () => {
    const harness = createHarness({ maxAgents: 1 })
    const results = await Promise.allSettled([
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'first',
        }),
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'b',
            message: 'second',
        }),
    ])

    assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1
    )
    assert.equal(
        results.filter((result) => result.status === 'rejected').length,
        1
    )
    assert.equal(harness.coordinator.list(ROOT_PATH).length, 1)
    for (const session of harness.sessions.values()) session.finishRun()
    await harness.coordinator.shutdown()
})

test('concurrent spawns cannot reserve the same path twice', async () => {
    const harness = createHarness()
    const results = await Promise.allSettled([
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'same',
            message: 'first',
        }),
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'same',
            message: 'second',
        }),
    ])

    assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1
    )
    assert.equal(
        results.filter((result) => result.status === 'rejected').length,
        1
    )
    assert.equal(harness.coordinator.list(ROOT_PATH).length, 1)
    harness.sessions.get('/root/same')?.finishRun()
    await harness.coordinator.shutdown()
})

test('operations during PendingInit await spawn initialization', async () => {
    const gate = new Deferred<void>()
    const started = new Deferred<void>()
    const harness = createHarness({
        createGate: gate,
        onCreateStarted: () => started.resolve(undefined),
    })
    const spawn = harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    await started.promise

    const send = harness.coordinator.sendMessage({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'queued while initializing',
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.opens.count, 0)

    gate.resolve(undefined)
    await Promise.all([spawn, send])
    assert.equal(harness.opens.count, 0)
    assert.equal(harness.sessions.get('/root/a')?.customMessages.length, 2)
    harness.sessions.get('/root/a')?.finishRun()
    await harness.coordinator.shutdown()
})

test('concurrent cold loads serialize global residency admission', async () => {
    const gate = new Deferred<void>()
    const harness = createHarness({ maxLoadedAgents: 1, openGate: gate })
    restoreOne(harness.coordinator)
    harness.coordinator.restore({
        version: 2,
        rootSessionId: 'root-session',
        persistedAt: Date.now(),
        agents: [
            {
                id: 'agent-b',
                path: '/root/b',
                parentPath: '/root',
                rootSessionId: 'root-session',
                sessionId: 'old-session-b',
                sessionFile: '/tmp/b.jsonl',
                cwd: '/repo',
                role: 'default',
                model: { provider: 'test-provider', id: 'test-model' },
                thinkingLevel: 'medium',
                activeTools: [],
                status: 'Completed',
                statusMessage: 'done',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                runSequence: 1,
                lastDeliveredRunSequence: 1,
            },
        ],
    })

    const sends = [
        harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/a',
            message: 'a',
        }),
        harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/b',
            message: 'b',
        }),
    ]
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.opens.count, 1)
    gate.resolve(undefined)
    await Promise.all(sends)
    assert.equal(harness.opens.count, 2)
    assert.equal(
        harness.coordinator
            .list(ROOT_PATH)
            .filter((agent) => agent.residency === 'loaded').length,
        1
    )
    await harness.coordinator.shutdown()
})

test('full-history fork accepts agent_type and applies role execution config', async () => {
    const harness = createHarness({
        roles: {
            reviewer: {
                model: 'role-provider/role-model',
                thinkingLevel: 'high',
                tools: ['review_tool'],
            },
        },
    })
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'review',
        message: 'review',
        forkTurns: 'all',
        agentType: 'reviewer',
    })
    const record = harness.coordinator.getRecordByPath(
        '/root/review' as AgentPath
    )!
    assert.equal(record.role, 'reviewer')
    assert.equal(record.model, 'role-provider/role-model')
    assert.equal(record.thinkingLevel, 'high')
    assert.ok(record.activeTools?.includes('review_tool'))
    harness.sessions.get('/root/review')?.finishRun()
    await harness.coordinator.shutdown()
})

test('concurrent unloaded operations share one AgentSession load', async () => {
    const gate = new Deferred<void>()
    const harness = createHarness({ openGate: gate })
    restoreOne(harness.coordinator)

    const send = harness.coordinator.sendMessage({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'queued',
    })
    const followup = harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'run',
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.opens.count, 1)
    assert.equal(harness.sessions.size, 0)

    gate.resolve(undefined)
    await Promise.all([send, followup])
    const loaded = harness.sessions.get('/root/a')!
    assert.equal(loaded.customMessages.length, 2)
    loaded.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.opens.count, 1)
    await harness.coordinator.shutdown()
})

test('followup during settling waits for settlement and starts a tracked run', async () => {
    const finalGate = new Deferred<void>()
    const finalStarted = new Deferred<void>()
    const harness = createHarness({
        finalGate,
        onFinalStarted: () => finalStarted.resolve(undefined),
    })
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'first',
    })
    const session = harness.sessions.get('/root/a')!
    session.finishRun()
    await finalStarted.promise

    const second = harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'second',
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(session.runCalls, 1)
    finalGate.resolve(undefined)
    await second
    assert.equal(session.runCalls, 2)
    session.finishRun()
    assert.ok(
        harness.rootMessages
            .filter((message) => message.kind === 'result')
            .every((message) => message.triggerTurn === false)
    )
    await harness.coordinator.shutdown()
})

test('followup wakes a child blocked in wait_agent', async () => {
    const harness = createHarness()
    const result = harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    await result
    const session = harness.sessions.get('/root/a')!
    assert.equal(session.customMessages.length, 1)
    const waiting = harness.coordinator.wait({ caller: '/root/a' as AgentPath })
    await harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'interrupt the wait',
    })
    assert.deepEqual(await waiting, {
        message: 'Wait interrupted by new input.',
        timedOut: false,
    })
    session.finishRun()
    await harness.coordinator.shutdown()
})

test('a reloaded agent continues its delivery sequence after eviction', async () => {
    const harness = createHarness({ maxLoadedAgents: 1 })
    restoreOne(harness.coordinator, {
        runSequence: 1,
        lastDeliveredRunSequence: 1,
    })
    await harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'resume a',
    })
    const a = harness.sessions.get('/root/a')!
    a.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'b',
        message: 'load b',
    })
    const b = harness.sessions.get('/root/b')!
    b.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    await harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'new run',
    })
    const reloaded = harness.sessions.get('/root/a')!
    reloaded.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    const record = harness.coordinator.getRecordByPath('/root/a' as AgentPath)!
    assert.equal(record.lastDeliveredRunSequence, 3)
    assert.equal(harness.opens.count, 2)
    await harness.coordinator.shutdown()
})
