import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { InterAgentCommunication } from '../domain/communication.ts'
import type { DeliveryOptions } from './transport.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { SubagentSessionFactory } from './session-factory.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'

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
    readonly entries: unknown[] = []
    readonly sessionManager = {
        getCwd: () => '/repo',
        buildContextEntries: () => [],
        getBranch: () => [],
        getEntries: () => this.entries,
    }
    readonly model: { provider: string; id: string }
    /** Physical model that answered; set when the selection is virtual. */
    routedModel?: { model: { provider: string; id: string } }
    readonly thinkingLevel: AgentRecord['thinkingLevel']
    readonly activeTools: string[]
    readonly customMessages: unknown[] = []
    readonly messages: unknown[] = []
    readonly extensionRunner = { emit: async () => undefined }
    isStreaming = false
    runCalls = 0
    disposed = false
    private readonly runs: Array<{
        finish: () => void
        fail: (error: unknown) => void
    }> = []

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
            await new Promise<void>((resolve, reject) => {
                this.runs.push({
                    finish: () => {
                        this.isStreaming = false
                        resolve()
                    },
                    fail: (error) => {
                        this.isStreaming = false
                        reject(error)
                    },
                })
            })
        }
    }

    finishRun(): void {
        this.runs.shift()?.finish()
    }

    failRun(error: unknown = new Error('run failed')): void {
        this.runs.shift()?.fail(error)
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
    readonly rootDeliveries: DeliveryOptions[]
}

function createHarness(options?: {
    maxAgents?: number
    maxConcurrentExecutions?: number
    maxLoadedAgents?: number
    openGate?: Deferred<void>
    createGate?: Deferred<void>
    onCreateStarted?: () => void
    finalGate?: Deferred<void>
    onFinalStarted?: () => void
    roles?: typeof DEFAULT_SUBAGENTS_CONFIG.roles
    isRootStreaming?: () => boolean
}): Harness {
    const sessions = new Map<string, FakeSession>()
    const opens = { count: 0 }
    const rootMessages: InterAgentCommunication[] = []
    const rootDeliveries: DeliveryOptions[] = []
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
            sendOptions: DeliveryOptions
        ) {
            rootMessages.push(communication)
            rootDeliveries.push(sendOptions)
            if (communication.kind === 'result' && options?.finalGate) {
                options.onFinalStarted?.()
                await options.finalGate.promise
            }
        },
    }
    const config = {
        ...DEFAULT_SUBAGENTS_CONFIG,
        maxAgents: options?.maxAgents ?? DEFAULT_SUBAGENTS_CONFIG.maxAgents,
        maxConcurrentExecutions:
            options?.maxConcurrentExecutions ??
            DEFAULT_SUBAGENTS_CONFIG.maxConcurrentExecutions,
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
        isRootStreaming: options?.isRootStreaming,
    })
    return { coordinator, sessions, opens, rootMessages, rootDeliveries }
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

test('nested completions admit an idle parent run and deliver its result to root', async () => {
    const harness = createHarness({ maxConcurrentExecutions: 1 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'parent',
            message: 'parent',
        })
        const parent = harness.sessions.get('/root/parent')!
        parent.finishRun()
        await new Promise((resolve) => setImmediate(resolve))
        await harness.coordinator.spawn({
            caller: '/root/parent' as AgentPath,
            taskName: 'worker',
            message: 'worker',
        })
        harness.sessions.get('/root/parent/worker')!.finishRun()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(parent.runCalls, 2)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/parent' as AgentPath)
                ?.status._tag,
            'Running'
        )
        await assert.rejects(
            harness.coordinator.spawn({
                caller: ROOT_PATH,
                taskName: 'other',
                message: 'other',
            }),
            /active slots/
        )
        parent.finishRun()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(
            harness.rootMessages.filter(
                (message) =>
                    message.author === '/root/parent' &&
                    message.kind === 'result'
            ).length,
            2
        )
        assert.equal(
            harness.coordinator.getRecordByPath('/root/parent' as AgentPath)
                ?.runSequence,
            2
        )
        assert.equal(
            harness.coordinator.getRecordByPath('/root/parent' as AgentPath)
                ?.status._tag,
            'Completed'
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('child send_message to root uses the root endpoint without opening a session', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })

    await harness.coordinator.sendMessage({
        caller: '/root/a' as AgentPath,
        target: '/root',
        message: 'progress',
    })

    assert.equal(harness.opens.count, 0)
    assert.equal(harness.rootMessages.at(-1)?.kind, 'message')
    assert.equal(harness.rootMessages.at(-1)?.payload, 'progress')
    assert.deepEqual(harness.rootDeliveries.at(-1), { triggerTurn: false })
    harness.sessions.get('/root/a')?.finishRun()
    await harness.coordinator.shutdown()
})

test('nested completion delivery steers the loaded parent session', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'parent',
        message: 'parent task',
    })
    await harness.coordinator.spawn({
        caller: '/root/parent' as AgentPath,
        taskName: 'worker',
        message: 'worker task',
    })
    harness.sessions.get('/root/parent/worker')?.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    const parent = harness.sessions.get('/root/parent')!
    const delivery = parent.customMessages.find((entry) => {
        const message = (entry as { message?: { content?: unknown } }).message
        return String(message?.content).includes('FINAL_ANSWER')
    }) as
        { options?: { triggerTurn?: boolean; deliverAs?: string } } | undefined
    assert.ok(delivery, 'parent session never received the FINAL_ANSWER')
    assert.equal(delivery?.options?.triggerTurn, true)
    assert.equal(delivery?.options?.deliverAs, 'steer')

    parent.finishRun()
    await harness.coordinator.shutdown()
})

test('send_message steers a streaming target but never starts an idle one', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    const session = harness.sessions.get('/root/a')!
    assert.equal(session.runCalls, 1)

    await harness.coordinator.sendMessage({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'note while busy',
    })
    const steered = session.customMessages.at(-1) as {
        options?: { triggerTurn?: boolean; deliverAs?: string }
    }
    assert.equal(steered.options?.triggerTurn, true)
    assert.equal(steered.options?.deliverAs, 'steer')
    assert.equal(session.runCalls, 1)

    session.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    await harness.coordinator.sendMessage({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'note while idle',
    })
    const appended = session.customMessages.at(-1) as {
        options?: { triggerTurn?: boolean }
    }
    assert.ok(!appended.options?.triggerTurn)
    assert.equal(session.runCalls, 1)
    assert.equal(session.isStreaming, false)
    await harness.coordinator.shutdown()
})

test('send_message to a busy root steers, to an idle root appends', async () => {
    const streaming = { current: true }
    const harness = createHarness({ isRootStreaming: () => streaming.current })
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    await harness.coordinator.sendMessage({
        caller: '/root/a' as AgentPath,
        target: '/root',
        message: 'note while root busy',
    })
    assert.deepEqual(harness.rootDeliveries.at(-1), {
        triggerTurn: true,
        delivery: 'steer',
    })

    streaming.current = false
    await harness.coordinator.sendMessage({
        caller: '/root/a' as AgentPath,
        target: '/root',
        message: 'note while root idle',
    })
    assert.deepEqual(harness.rootDeliveries.at(-1), { triggerTurn: false })
    harness.sessions.get('/root/a')?.finishRun()
    await harness.coordinator.shutdown()
})

test('spawn stores the initial task and it survives serialize/restore', async () => {
    const first = createHarness()
    await first.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'Do the thing with care.',
    })
    assert.equal(
        first.coordinator.getRecordByPath('/root/a' as AgentPath)?.task,
        'Do the thing with care.'
    )
    const snapshot = first.coordinator.serialize('root-session')
    assert.equal(snapshot.agents[0]?.task, 'Do the thing with care.')
    first.sessions.get('/root/a')?.finishRun()
    await first.coordinator.shutdown()

    const second = createHarness()
    second.coordinator.restore(snapshot)
    assert.equal(
        second.coordinator.getRecordByPath('/root/a' as AgentPath)?.task,
        'Do the thing with care.'
    )
    await second.coordinator.shutdown()
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
            .every((message) => message.triggerTurn === true)
    )
    // Completion delivery steers so a running parent ingests the payload
    // mid-run instead of finding it only on the next user prompt.
    assert.ok(
        harness.rootDeliveries
            .filter(
                (_, index) => harness.rootMessages[index]?.kind === 'result'
            )
            .every((delivery) => {
                const mode = (delivery as unknown as Record<string, unknown>)
                    .deliverAs
                return (
                    delivery.triggerTurn === true &&
                    (delivery.delivery ?? mode) === 'steer'
                )
            })
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

test('aborting a wait leaves the waiting agent untouched', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    const controller = new AbortController()
    const waiting = harness.coordinator.wait({
        caller: '/root/a' as AgentPath,
        signal: controller.signal,
    })
    controller.abort()
    await assert.rejects(waiting, /Wait cancelled/)
    assert.equal(
        harness.coordinator.getRecordByPath('/root/a' as AgentPath)?.status
            ._tag,
        'Running'
    )
    harness.sessions.get('/root/a')?.finishRun()
    await harness.coordinator.shutdown()
})

test('shutdown cancels a pending wait instead of waiting for its timeout', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    const waiting = harness.coordinator.wait({
        caller: '/root/a' as AgentPath,
        timeoutMs: 3_600_000,
    })
    const shutdown = harness.coordinator.shutdown()
    await assert.rejects(waiting, /Wait cancelled/)
    await shutdown
})

test('spawn rejects invalid forks, empty messages, and bad task names', async () => {
    const harness = createHarness()
    await assert.rejects(
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: '   ',
        }),
        /Message must not be empty/
    )
    await assert.rejects(
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'Bad Name',
            message: 'x',
        }),
        /Invalid task_name/
    )
    await assert.rejects(
        harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'x',
            forkTurns: '0',
        }),
        /Invalid fork_turns/
    )
    await harness.coordinator.shutdown()
})

test('followup cannot target /root', async () => {
    const harness = createHarness()
    await assert.rejects(
        harness.coordinator.followup({
            caller: ROOT_PATH,
            target: '/root',
            message: 'x',
        }),
        /cannot target \/root/
    )
    await harness.coordinator.shutdown()
})

test('interrupt preserves identity and allows a later followup', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    const status = await harness.coordinator.interrupt({
        caller: ROOT_PATH,
        target: '/root/a',
    })
    assert.equal(status._tag, 'Interrupted')
    assert.equal(
        harness.coordinator.getRecordByPath('/root/a' as AgentPath)?.status
            ._tag,
        'Interrupted'
    )
    const followup = harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/a',
        message: 'again',
    })
    await new Promise((resolve) => setImmediate(resolve))
    harness.sessions.get('/root/a')?.finishRun()
    await followup
    assert.equal(harness.sessions.get('/root/a')?.runCalls, 2)
    await harness.coordinator.shutdown()
})

test('usage follows the physical model and lists the tools that ran', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'virtual',
        message: 'start',
    })
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'physical',
        message: 'start',
    })
    const virtual = harness.sessions.get('/root/virtual')!
    virtual.routedModel = {
        model: { provider: 'physical-provider', id: 'physical-model' },
    }
    virtual.entries.push(
        {
            type: 'message',
            message: {
                role: 'assistant',
                content: [
                    { type: 'toolCall', name: 'read' },
                    { type: 'toolCall', name: 'bash' },
                ],
            },
        },
        {
            type: 'message',
            message: {
                role: 'assistant',
                content: [{ type: 'toolCall', name: 'read' }],
            },
        },
        { type: 'message', message: { role: 'user', content: 'text' } }
    )
    for (const path of ['/root/virtual', '/root/physical']) {
        harness.sessions.get(path)?.finishRun()
    }
    await new Promise((resolve) => setImmediate(resolve))

    const routed = harness.coordinator.getRecordByPath(
        '/root/virtual' as AgentPath
    )?.usage
    assert.equal(routed?.provider, 'physical-provider')
    assert.equal(routed?.modelId, 'physical-model')
    assert.deepEqual(routed?.toolCalls, [
        { name: 'read', count: 2 },
        { name: 'bash', count: 1 },
    ])

    // Without a routed model the selection is what the snapshot reports.
    const selected = harness.coordinator.getRecordByPath(
        '/root/physical' as AgentPath
    )?.usage
    assert.equal(selected?.provider, 'test-provider')
    assert.equal(selected?.modelId, 'test-model')
    assert.deepEqual(selected?.toolCalls, [])
    await harness.coordinator.shutdown()
})

test('list reports which agents are blocked in wait_agent', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    const listed = () => harness.coordinator.list(ROOT_PATH)
    assert.equal(listed()[0]?.waiting, false)

    const controller = new AbortController()
    const waiting = harness.coordinator.wait({
        caller: '/root/a' as AgentPath,
        signal: controller.signal,
    })
    assert.equal(listed()[0]?.waiting, true)

    controller.abort()
    await assert.rejects(waiting, /Wait cancelled/)
    assert.equal(listed()[0]?.waiting, false)
    harness.sessions.get('/root/a')?.finishRun()
    await harness.coordinator.shutdown()
})

test('completions carry transcript metadata for the card', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'done',
        message: 'start',
    })
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'broken',
        message: 'start',
    })
    harness.sessions.get('/root/done')?.finishRun()
    harness.sessions.get('/root/broken')?.failRun(new Error('compile error'))
    await new Promise((resolve) => setImmediate(resolve))

    const results = harness.rootMessages.filter(
        (message) => message.kind === 'result'
    )
    const completed = results.find((message) => message.author === '/root/done')
    assert.equal(completed?.meta?.model, 'test-provider/test-model')
    assert.equal(completed?.meta?.tokens, 2)
    assert.equal(completed?.meta?.failed, undefined)
    assert.equal(typeof completed?.meta?.durationMs, 'number')

    const failed = results.find((message) => message.author === '/root/broken')
    assert.equal(failed?.meta?.failed, true)
    assert.match(String(failed?.payload), /Agent errored/)
    await harness.coordinator.shutdown()
})

test('recent turns are captured for the inspector', async () => {
    const harness = createHarness()
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'start',
    })
    const session = harness.sessions.get('/root/a')!
    session.messages.push(
        { role: 'user', content: 'do the thing' },
        {
            role: 'assistant',
            content: [{ type: 'text', text: 'did the thing' }],
        }
    )
    session.finishRun()
    await new Promise((resolve) => setImmediate(resolve))

    const turns = harness.coordinator.getRecentTurns('/root/a' as AgentPath)
    assert.ok(turns.some((turn) => turn.text === 'do the thing'))
    assert.equal(turns.at(-1)?.text, 'did the thing')
    assert.equal(turns.at(-1)?.role, 'assistant')
    await harness.coordinator.shutdown()
})

test('failed nested completion delivery remains queued until the parent reloads', async () => {
    const harness = createHarness({ maxLoadedAgents: 2 })
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'parent',
        message: 'parent task',
    })
    await harness.coordinator.spawn({
        caller: '/root/parent' as AgentPath,
        taskName: 'worker',
        message: 'worker task',
    })
    harness.sessions.get('/root/parent')?.finishRun()
    await new Promise((resolve) => setImmediate(resolve))

    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'other',
        message: 'other task',
    })
    harness.sessions.get('/root/parent/worker')?.finishRun()
    await new Promise((resolve) => setImmediate(resolve))

    const worker = harness.coordinator.getRecordByPath(
        '/root/parent/worker' as AgentPath
    )!
    assert.equal(worker.pendingCompletions?.length, 1)

    harness.sessions.get('/root/other')?.finishRun()
    await new Promise((resolve) => setImmediate(resolve))
    // Reloading retries the queued completion first. Steered delivery starts
    // a parent run (as in real Pi), then the followup starts its own run:
    // drive both, since the fake harness has no live model loop.
    const followupPromise = harness.coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/parent',
        message: 'resume parent',
    })
    for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setImmediate(resolve))
        harness.sessions.get('/root/parent')?.finishRun()
    }
    await followupPromise

    const reloadedParent = harness.sessions.get('/root/parent')!
    assert.ok(
        reloadedParent.customMessages.some((delivery) => {
            const message = (delivery as { message?: { content?: unknown } })
                .message
            return String(message?.content).includes('FINAL_ANSWER')
        })
    )
    assert.equal(
        harness.coordinator.getRecordByPath('/root/parent/worker' as AgentPath)
            ?.pendingCompletions?.length,
        0
    )
    reloadedParent.finishRun()
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
