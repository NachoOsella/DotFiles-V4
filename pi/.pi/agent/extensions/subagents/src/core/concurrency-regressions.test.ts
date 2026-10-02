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
    resolve!: (value: T) => void

    constructor() {
        this.promise = new Promise<T>((resolve) => {
            this.resolve = resolve
        })
    }
}

interface SendOptions {
    triggerTurn?: boolean
    deliverAs?: string
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
    readonly thinkingLevel: AgentRecord['thinkingLevel']
    readonly activeTools: string[]
    readonly messages: unknown[] = []
    readonly customMessages: Array<{
        message: Record<string, unknown>
        options: SendOptions
    }> = []
    readonly extensionRunner = { emit: async () => undefined }
    isStreaming = false
    runCalls = 0
    disposed = false
    rejectNextSend: Error | undefined
    private readonly runs: Array<Deferred<void>> = []

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
        options?: SendOptions
    ): Promise<void> {
        const record = message as Record<string, unknown>
        this.customMessages.push({ message: record, options: options ?? {} })
        this.messages.push({ role: 'custom', content: record.content })
        if (!options?.triggerTurn) return
        if (this.isStreaming) return
        if (this.rejectNextSend) {
            const error = this.rejectNextSend
            this.rejectNextSend = undefined
            throw error
        }
        this.isStreaming = true
        this.runCalls += 1
        const run = new Deferred<void>()
        this.runs.push(run)
        await run.promise
    }

    finishRun(): void {
        const run = this.runs.shift()
        if (!run) return
        this.isStreaming = false
        run.resolve(undefined)
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
    readonly rootMessages: InterAgentCommunication[]
}

function createHarness(options?: {
    maxAgents?: number
    maxConcurrentExecutions?: number
    maxLoadedAgents?: number
    /** Mutable gate for tests that arm it after some sessions are open. */
    openGateRef?: { gate?: Deferred<void> }
    rootGate?: Deferred<void>
    onRootResultStarted?: () => void
    isRootStreaming?: () => boolean
}): Harness {
    const sessions = new Map<string, FakeSession>()
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
            return makeRuntime(record)
        },
        async open(record) {
            const gate = options?.openGateRef?.gate
            if (gate) await gate.promise
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
            if (communication.kind === 'result' && options?.rootGate) {
                options.onRootResultStarted?.()
                await options.rootGate.promise
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
    return {
        coordinator,
        sessions,
        rootMessages,
    }
}

function restoredAgent(args: {
    id: string
    path: string
    parentPath: string
    runSequence?: number
    lastDeliveredRunSequence?: number
    status?: string
    pendingCompletions?: readonly {
        communicationId: string
        runSequence: number
        author: string
        recipient: string
        payload: string
    }[]
}) {
    return {
        id: args.id,
        path: args.path,
        parentPath: args.parentPath,
        rootSessionId: 'root-session',
        sessionId: `old-${args.id}`,
        sessionFile: `/tmp/${args.id}.jsonl`,
        cwd: '/repo',
        role: 'default',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium' as const,
        activeTools: ['spawn_agent', 'send_message', 'followup_task'],
        status: args.status ?? 'Completed',
        statusMessage: 'done',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        runSequence: args.runSequence ?? 1,
        ...(args.lastDeliveredRunSequence !== undefined
            ? { lastDeliveredRunSequence: args.lastDeliveredRunSequence }
            : {}),
        ...(args.pendingCompletions
            ? { pendingCompletions: args.pendingCompletions }
            : {}),
    }
}

function restore(
    coordinator: SubagentCoordinator,
    agents: ReadonlyArray<ReturnType<typeof restoredAgent>>
) {
    coordinator.restore({
        version: 2,
        rootSessionId: 'root-session',
        persistedAt: Date.now(),
        agents,
    })
}

function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

async function flushTimes(count: number): Promise<void> {
    for (let i = 0; i < count; i++) await flush()
}

async function withTimeout<T>(
    promise: Promise<T>,
    label: string,
    ms = 500
): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timed out (${ms}ms): ${label}`)),
            ms
        )
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function finalAnswerIndexes(session: FakeSession): number[] {
    const indexes: number[] = []
    session.customMessages.forEach((entry, index) => {
        if (String(entry.message.content).includes('FINAL_ANSWER')) {
            indexes.push(index)
        }
    })
    return indexes
}

test('loading a parent retries queued child completions exactly once without deadlock', async () => {
    const harness = createHarness({ maxLoadedAgents: 1 })
    try {
        restore(harness.coordinator, [
            restoredAgent({
                id: 'parent',
                path: '/root/parent',
                parentPath: '/root',
            }),
            restoredAgent({
                id: 'worker',
                path: '/root/parent/worker',
                parentPath: '/root/parent',
                pendingCompletions: [
                    {
                        communicationId: 'c1',
                        runSequence: 1,
                        author: '/root/parent/worker',
                        recipient: '/root/parent',
                        payload: 'worker finished',
                    },
                ],
            }),
        ])

        await withTimeout(
            harness.coordinator.sendMessage({
                caller: ROOT_PATH,
                target: '/root/parent',
                message: 'wake',
            }),
            'load parent and retry pending completion'
        )

        const parent = harness.sessions.get('/root/parent')
        assert.ok(parent, 'parent session was never opened')
        assert.equal(parent.runCalls, 1)
        assert.equal(finalAnswerIndexes(parent).length, 1)
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length,
            0
        )
        parent.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('two children completing against a settling parent deliver once each', async () => {
    const harness = createHarness({ maxConcurrentExecutions: 2 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'parent',
            message: 'parent',
        })
        const parent = harness.sessions.get('/root/parent')!
        // Parent settles its first run while both workers finish.
        parent.finishRun()
        await flushTimes(2)

        await harness.coordinator.spawn({
            caller: '/root/parent' as AgentPath,
            taskName: 'w1',
            message: 'w1',
        })
        await harness.coordinator.spawn({
            caller: '/root/parent' as AgentPath,
            taskName: 'w2',
            message: 'w2',
        })
        const w1 = harness.sessions.get('/root/parent/w1')!
        const w2 = harness.sessions.get('/root/parent/w2')!
        w1.finishRun()
        w2.finishRun()
        await flushTimes(4)

        const answers = finalAnswerIndexes(parent)
        assert.equal(answers.length, 2)
        parent.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('a queued completion is not stranded when its parent loads while all slots are busy', async () => {
    const harness = createHarness({ maxConcurrentExecutions: 1 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'busy',
            message: 'busy',
        })
        const busy = harness.sessions.get('/root/busy')!
        assert.equal(busy.runCalls, 1)

        restore(harness.coordinator, [
            restoredAgent({
                id: 'parent',
                path: '/root/parent',
                parentPath: '/root',
            }),
            restoredAgent({
                id: 'worker',
                path: '/root/parent/worker',
                parentPath: '/root/parent',
                pendingCompletions: [
                    {
                        communicationId: 'c1',
                        runSequence: 1,
                        author: '/root/parent/worker',
                        recipient: '/root/parent',
                        payload: 'worker finished',
                    },
                ],
            }),
        ])

        await withTimeout(
            harness.coordinator.sendMessage({
                caller: ROOT_PATH,
                target: '/root/parent',
                message: 'wake',
            }),
            'load parent while slots are busy'
        )
        const parent = harness.sessions.get('/root/parent')!
        assert.equal(parent.runCalls, 0, 'no slot was available for the parent')

        busy.finishRun()
        await flushTimes(6)

        // Once the slot frees the queued completion should still find the
        // parent without requiring an eviction or reload.
        assert.equal(parent.runCalls, 1)
        assert.equal(finalAnswerIndexes(parent).length, 1)
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length,
            0
        )
        parent.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('concurrent spawn and followup on the same new path both deliver', async () => {
    const harness = createHarness()
    try {
        const spawn = harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'p',
            message: 'spawn-payload',
        })
        // Wait until the spawn has reserved the path, then race the followup
        // against the spawn's own initial run.
        for (let i = 0; i < 50; i++) {
            if (harness.coordinator.getRecordByPath('/root/p' as AgentPath)) {
                break
            }
            await flush()
        }
        const followup = harness.coordinator.followup({
            caller: ROOT_PATH,
            target: '/root/p',
            message: 'followup-payload',
        })
        await withTimeout(
            Promise.all([spawn, followup]),
            'spawn and followup the same path'
        )
        const session = harness.sessions.get('/root/p')!
        const contents = session.customMessages.map((entry) =>
            String(entry.message.content)
        )
        assert.ok(
            contents.some((content) => content.includes('spawn-payload')),
            'spawn payload was dropped'
        )
        assert.ok(
            contents.some((content) => content.includes('followup-payload')),
            'followup payload was dropped'
        )
        session.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('a completion waits for a settling parent and then starts a tracked run', async () => {
    const rootGate = new Deferred<void>()
    const rootStarted = new Deferred<void>()
    const harness = createHarness({
        rootGate,
        onRootResultStarted: () => rootStarted.resolve(undefined),
    })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'parent',
            message: 'parent',
        })
        await harness.coordinator.spawn({
            caller: '/root/parent' as AgentPath,
            taskName: 'worker',
            message: 'worker',
        })
        const parent = harness.sessions.get('/root/parent')!
        const worker = harness.sessions.get('/root/parent/worker')!

        // Parent settles first and blocks forwarding its own result to root.
        parent.finishRun()
        await withTimeout(rootStarted.promise, 'parent result forwarding')
        assert.equal(
            harness.coordinator.getRecordByPath('/root/parent' as AgentPath)
                ?.status._tag,
            'Completed'
        )

        // Worker completes while the parent is settling.
        worker.finishRun()
        await flushTimes(4)
        assert.equal(
            parent.runCalls,
            1,
            'parent must not run before its settlement finishes'
        )

        rootGate.resolve(undefined)
        await flushTimes(6)
        assert.equal(parent.runCalls, 2, 'parent continuation did not start')
        assert.equal(finalAnswerIndexes(parent).length, 1)
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length ?? 0,
            0
        )
        parent.finishRun()
        await flushTimes(3)
    } finally {
        rootGate.resolve(undefined)
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('retrying a cold parent does not deliver the same completion twice', async () => {
    const harness = createHarness({ maxLoadedAgents: 1 })
    try {
        restore(harness.coordinator, [
            restoredAgent({
                id: 'parent',
                path: '/root/parent',
                parentPath: '/root',
            }),
            restoredAgent({
                id: 'worker',
                path: '/root/parent/worker',
                parentPath: '/root/parent',
                pendingCompletions: [
                    {
                        communicationId: 'c1',
                        runSequence: 1,
                        author: '/root/parent/worker',
                        recipient: '/root/parent',
                        payload: 'worker finished',
                    },
                ],
            }),
        ])

        // A drain that runs before the parent is resident still has to load it.
        // The registration retry and the caller must not both deliver the same
        // envelope.
        await withTimeout(
            harness.coordinator.retryPendingCompletions(
                '/root/parent' as AgentPath
            ),
            'retry a cold parent'
        )
        const parent = harness.sessions.get('/root/parent')!
        assert.equal(
            finalAnswerIndexes(parent).length,
            1,
            'the same FINAL_ANSWER was delivered twice'
        )
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length,
            0
        )
        parent.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('concurrent retries of the same completion deliver it once', async () => {
    const harness = createHarness({ maxConcurrentExecutions: 1 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'busy',
            message: 'busy',
        })
        restore(harness.coordinator, [
            restoredAgent({
                id: 'parent',
                path: '/root/parent',
                parentPath: '/root',
            }),
            restoredAgent({
                id: 'worker',
                path: '/root/parent/worker',
                parentPath: '/root/parent',
                pendingCompletions: [
                    {
                        communicationId: 'c1',
                        runSequence: 1,
                        author: '/root/parent/worker',
                        recipient: '/root/parent',
                        payload: 'worker finished',
                    },
                ],
            }),
        ])
        // Load the parent while the only slot is busy, leaving the outbox
        // entry queued but the parent resident and idle.
        await withTimeout(
            harness.coordinator.sendMessage({
                caller: ROOT_PATH,
                target: '/root/parent',
                message: 'wake',
            }),
            'load parent with a queued outbox entry'
        )
        const busy = harness.sessions.get('/root/busy')!
        busy.finishRun()
        await flushTimes(4)

        await withTimeout(
            Promise.all([
                harness.coordinator.retryPendingCompletions(
                    '/root/parent' as AgentPath
                ),
                harness.coordinator.retryPendingCompletions(
                    '/root/parent' as AgentPath
                ),
            ]),
            'concurrent outbox drains'
        )
        const parent = harness.sessions.get('/root/parent')!
        assert.equal(
            finalAnswerIndexes(parent).length,
            1,
            'concurrent drains delivered the same FINAL_ANSWER twice'
        )
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length,
            0
        )
        parent.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('a native send failure during completion forwarding frees the execution slot', async () => {
    const harness = createHarness({ maxConcurrentExecutions: 1 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'parent',
            message: 'parent',
        })
        const parent = harness.sessions.get('/root/parent')!
        parent.finishRun()
        await flushTimes(2)

        await harness.coordinator.spawn({
            caller: '/root/parent' as AgentPath,
            taskName: 'worker',
            message: 'worker',
        })
        parent.rejectNextSend = new Error('native send exploded')
        harness.sessions.get('/root/parent/worker')!.finishRun()
        await flushTimes(4)

        const spawned = harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'other',
            message: 'other',
        })
        await withTimeout(spawned, 'spawn other after failed forwarding')
        harness.sessions.get('/root/other')?.finishRun()
        await flushTimes(3)
    } finally {
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('an interrupted child survives reload without a completion and can resume', async () => {
    const first = createHarness()
    let snapshot
    try {
        await first.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'worker',
        })
        await first.coordinator.interrupt({
            caller: ROOT_PATH,
            target: '/root/worker',
        })
        assert.equal(
            first.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Interrupted'
        )
        assert.equal(
            first.rootMessages.filter(
                (message) => message.author === '/root/worker'
            ).length,
            0
        )
        snapshot = first.coordinator.serialize('root-session')
    } finally {
        await withTimeout(first.coordinator.shutdown(), 'shutdown', 1000)
    }

    const second = createHarness()
    try {
        second.coordinator.restore(snapshot)
        assert.equal(
            second.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Interrupted'
        )
        await second.coordinator.followup({
            caller: ROOT_PATH,
            target: '/root/worker',
            message: 'resume',
        })
        const worker = second.sessions.get('/root/worker')!
        assert.equal(worker.runCalls, 1)
        worker.finishRun()
        await flushTimes(4)
        assert.equal(
            second.rootMessages.filter(
                (message) =>
                    message.author === '/root/worker' &&
                    message.kind === 'result'
            ).length,
            1
        )
    } finally {
        await withTimeout(second.coordinator.shutdown(), 'shutdown', 1000)
    }
})

test('a completion queued during shutdown stays in the durable outbox', async () => {
    const harness = createHarness({ maxLoadedAgents: 2 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'parent',
            message: 'parent',
        })
        harness.sessions.get('/root/parent')!.finishRun()
        await flushTimes(2)
        await harness.coordinator.spawn({
            caller: '/root/parent' as AgentPath,
            taskName: 'worker',
            message: 'worker',
        })
        // Evict the idle parent so the worker's completion cannot be forwarded
        // and has to enter the outbox.
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'other',
            message: 'other',
        })
        harness.sessions.get('/root/parent/worker')!.finishRun()
        await flushTimes(4)
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length,
            1
        )

        const snapshot = harness.coordinator.serialize('root-session')
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
        const persisted = snapshot.agents.find(
            (agent) => agent.path === '/root/parent/worker'
        )
        assert.equal(persisted?.pendingCompletions?.length, 1)
    } finally {
        await flushTimes(2)
    }
})

test('a stale outbox retry does not follow a newer completion into the parent', async () => {
    const openGateRef: { gate?: Deferred<void> } = {}
    const harness = createHarness({
        maxLoadedAgents: 4,
        maxConcurrentExecutions: 2,
        openGateRef,
    })
    try {
        restore(harness.coordinator, [
            restoredAgent({
                id: 'parent',
                path: '/root/parent',
                parentPath: '/root',
            }),
            restoredAgent({
                id: 'worker',
                path: '/root/parent/worker',
                parentPath: '/root/parent',
                runSequence: 1,
                pendingCompletions: [
                    {
                        communicationId: 'c1',
                        runSequence: 1,
                        author: '/root/parent/worker',
                        recipient: '/root/parent',
                        payload: 'first result',
                    },
                ],
            }),
        ])
        await withTimeout(
            harness.coordinator.followup({
                caller: ROOT_PATH,
                target: '/root/parent/worker',
                message: 'second task',
            }),
            'start the worker second run'
        )
        const worker = harness.sessions.get('/root/parent/worker')!
        assert.equal(worker.runCalls, 1)

        // Arm the gate so the cold-parent load stalls. The worker's newer
        // delivery and the stale outbox retry then race on the same load.
        openGateRef.gate = new Deferred<void>()
        worker.finishRun()
        await flushTimes(2)
        const retry = harness.coordinator.retryPendingCompletions(
            '/root/parent' as AgentPath
        )
        await flushTimes(2)
        openGateRef.gate.resolve(undefined)
        await withTimeout(retry, 'stale retry after the cold parent loads')
        await flushTimes(8)

        const parent = harness.sessions.get('/root/parent')!
        const answers = parent.customMessages
            .map((entry) => String(entry.message.content))
            .filter((content) => content.includes('FINAL_ANSWER'))
        assert.equal(
            answers.length,
            1,
            'the superseded outbox result was delivered next to the newer one'
        )
        assert.ok(
            answers[0]?.includes('done'),
            'the delivered result must be the newer run'
        )
        parent.finishRun()
        await flushTimes(3)
    } finally {
        openGateRef.gate?.resolve(undefined)
        await withTimeout(harness.coordinator.shutdown(), 'shutdown', 1000)
    }
})
