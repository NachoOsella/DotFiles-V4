import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { InterAgentCommunication } from '../domain/communication.ts'
import type { DeliveryCheckpointEvent } from '../domain/events.ts'
import type { InsertionState } from './transport.ts'

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

type SessionEvent = Record<string, unknown>

class FakeSession {
    readonly sessionId: string
    readonly sessionFile: string
    readonly entries: unknown[] = []
    readonly sessionManager = {
        getCwd: () => '/repo',
        buildContextEntries: () => [],
        getBranch: () => this.entries,
        getEntries: () => this.entries,
    }
    readonly model: { provider: string; id: string }
    readonly thinkingLevel: AgentRecord['thinkingLevel']
    readonly activeTools: string[]
    readonly customMessages: Array<{
        message: Record<string, unknown>
        options: { triggerTurn?: boolean; deliverAs?: string }
    }> = []
    readonly messages: unknown[] = []
    readonly extensionRunner = { emit: async () => undefined }
    readonly listeners = new Set<(event: SessionEvent) => void>()
    isStreaming = false
    get isIdle(): boolean {
        return !this.isStreaming
    }
    runCalls = 0
    disposed = false
    rejected = false
    probeUnknown = false
    insertOnSend = true
    rejectNextSend: Error | undefined
    holdRun = true
    stats = {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolResults: 0,
    }
    private runs: Deferred<void>[] = []

    constructor(id: string, record: AgentRecord, entries?: unknown[]) {
        this.sessionId = `session-${id}`
        this.sessionFile = record.sessionFile ?? `/tmp/${id}.jsonl`
        this.entries.push(...(entries ?? []))
        const model = record.model
        const separator = model.indexOf('/')
        this.model = {
            provider: model.slice(0, separator),
            id: model.slice(separator + 1),
        }
        this.thinkingLevel = record.thinkingLevel ?? 'medium'
        this.activeTools = [...(record.activeTools ?? [])]
    }

    subscribe(listener: (event: SessionEvent) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: SessionEvent): void {
        for (const listener of [...this.listeners]) listener(event)
    }

    insert(communication: InterAgentCommunication): void {
        const details = {
            id: communication.id,
            kind: communication.kind,
            messageType: communication.messageType,
        }
        const message = {
            role: 'custom',
            customType: 'subagents-v3:communication',
            content: communication.payload,
            details,
        }
        this.entries.push({
            type: 'custom_message',
            customType: 'subagents-v3:communication',
            details,
            content: communication.payload,
            display: false,
        })
        this.messages.push(message)
        this.emit({ type: 'message_end', message })
    }

    async sendCustomMessage(
        message: unknown,
        options?: { triggerTurn?: boolean; deliverAs?: string }
    ): Promise<void> {
        const record = message as Record<string, unknown>
        this.customMessages.push({ message: record, options: options ?? {} })
        if (this.rejectNextSend) {
            const error = this.rejectNextSend
            this.rejectNextSend = undefined
            this.rejected = true
            throw error
        }
        if (this.insertOnSend) {
            const details = record.details as { id?: string } | undefined
            if (details?.id) {
                const body = {
                    id: details.id,
                } as InterAgentCommunication
                this.insert(body)
            }
        }
        if (!options?.triggerTurn) return
        if (this.isStreaming) return
        this.isStreaming = true
        this.runCalls += 1
        const run = new Deferred<void>()
        this.runs.push(run)
        if (!this.holdRun) {
            queueMicrotask(() => this.finishRun())
        }
        await run.promise
    }

    finishRun(): void {
        const run = this.runs.shift()
        if (!run) return
        this.isStreaming = false
        run.resolve(undefined)
        this.emit({ type: 'agent_settled' })
    }

    abort(): Promise<void> {
        this.isStreaming = false
        const run = this.runs.shift()
        run?.resolve(undefined)
        this.emit({ type: 'agent_settled' })
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
        return this.stats
    }
}

interface Harness {
    coordinator: SubagentCoordinator
    readonly sessions: Map<string, FakeSession>
    readonly rootEntries: unknown[]
    readonly rootSends: InterAgentCommunication[]
    readonly checkpoints: DeliveryCheckpointEvent[]
    rootReject: Error | undefined
    rootInsert: boolean
    rootProbe: InsertionState | 'throw' | undefined
    failIntent: boolean
    failReceipt: boolean
    onCheckpoint?: (event: DeliveryCheckpointEvent) => void
    beforeCheckpoint?: (event: DeliveryCheckpointEvent) => void
}

function createHarness(options?: {
    maxAgents?: number
    maxLoadedAgents?: number
    maxConcurrentExecutions?: number
}): Harness {
    const sessions = new Map<string, FakeSession>()
    const rootEntries: unknown[] = []
    const rootSends: InterAgentCommunication[] = []
    const checkpoints: DeliveryCheckpointEvent[] = []
    const harness = {
        sessions,
        rootEntries,
        rootSends,
        checkpoints,
        rootReject: undefined,
        rootInsert: true,
        rootProbe: undefined,
        failIntent: false,
        failReceipt: false,
    } as Harness
    const makeRuntime = (record: AgentRecord): AgentRuntime => {
        const existing = sessions.get(record.path as string)
        const session =
            existing ??
            new FakeSession(record.path.replaceAll('/', '_'), record)
        sessions.set(record.path as string, session)
        return makeAgentRuntime({
            path: record.path,
            session: session as unknown as AgentSession,
            runSequence: record.runSequence,
        })
    }
    const rootEndpoint = {
        path: ROOT_PATH,
        async send(communication: InterAgentCommunication) {
            rootSends.push(communication)
            if (harness.rootReject) throw harness.rootReject
            if (harness.rootInsert)
                rootEntries.push(communicationEntry(communication))
        },
        probeInsertion(communicationId: string): InsertionState {
            if (harness.rootProbe === 'throw') throw new Error('probe failed')
            if (harness.rootProbe) return harness.rootProbe
            return rootEntries.some(
                (entry) => entryId(entry) === communicationId
            )
                ? 'accepted'
                : 'absent'
        },
    }
    const coordinator = new SubagentCoordinator({
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            maxAgents: options?.maxAgents ?? 8,
            maxLoadedAgents: options?.maxLoadedAgents ?? 8,
            maxConcurrentExecutions: options?.maxConcurrentExecutions ?? 4,
        },
        getRootSnapshot: () => ({
            path: ROOT_PATH,
            cwd: '/repo',
            model: { provider: 'test-provider', id: 'test-model' },
            thinkingLevel: 'medium',
            activeTools: ['spawn_agent'],
            contextEntries: [],
            sessionId: 'root-session',
        }),
        rootEndpoint,
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({}) as never,
        buildTools: () => [],
        deliveryReceipts: true,
        sessionFactory: {
            async create(record) {
                return makeRuntime(record)
            },
            async open(record) {
                return makeRuntime(record)
            },
        },
    })
    harness.coordinator = coordinator
    coordinator.onDeliveryCheckpoint((event) => {
        harness.beforeCheckpoint?.(event)
        if (event.reason === 'intent-persisted' && harness.failIntent) {
            throw new Error('intent checkpoint failed')
        }
        if (event.reason === 'receipt-accepted' && harness.failReceipt) {
            throw new Error('receipt checkpoint failed')
        }
        checkpoints.push(event)
        harness.onCheckpoint?.(event)
    })
    return harness
}

function communicationEntry(communication: InterAgentCommunication) {
    return {
        type: 'custom_message',
        customType: 'subagents-v3:communication',
        details: {
            id: communication.id,
            kind: communication.kind,
            messageType: communication.messageType,
        },
        content: communication.payload,
    }
}

function entryId(entry: unknown): string | undefined {
    if (!entry || typeof entry !== 'object') return undefined
    const details = (entry as { details?: { id?: unknown } }).details
    return typeof details?.id === 'string' ? details.id : undefined
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function flushTimes(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) await flush()
}

async function spawn(
    harness: Harness,
    caller: AgentPath,
    taskName: string
): Promise<void> {
    await harness.coordinator.spawn({
        caller,
        taskName,
        message: taskName,
    })
}

function restored(
    path: string,
    parentPath: string,
    options: {
        id?: string
        pending?: readonly {
            id: string
            runSequence: number
            payload: string
        }[]
    } = {}
) {
    return {
        id: options.id ?? path.replaceAll('/', '_'),
        path,
        parentPath,
        rootSessionId: 'root-session',
        sessionId: `old-${path}`,
        sessionFile: `/tmp/${path.replaceAll('/', '_')}.jsonl`,
        cwd: '/repo',
        role: 'default',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium' as const,
        activeTools: ['spawn_agent'],
        status: 'Completed',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        runSequence: 1,
        ...(options.pending
            ? {
                  pendingCompletions: options.pending.map((item) => ({
                      communicationId: item.id,
                      runSequence: item.runSequence,
                      author: path,
                      recipient: parentPath,
                      payload: item.payload,
                  })),
              }
            : {}),
    }
}

test('root void dispatch stays pending until the transcript receipt is observed', async () => {
    const harness = createHarness()
    const sendObserved: Array<{ pending: number; sends: number }> = []
    harness.onCheckpoint = (event) => {
        if (event.reason !== 'intent-persisted') return
        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        sendObserved.push({
            pending: record?.pendingCompletions?.length ?? 0,
            sends: harness.rootSends.length,
        })
    }
    try {
        harness.rootInsert = false
        await spawn(harness, ROOT_PATH, 'worker')
        harness.sessions.get('/root/worker')!.finishRun()
        await flushTimes(4)

        assert.equal(harness.rootSends.length, 1)
        assert.deepEqual(sendObserved, [{ pending: 1, sends: 0 }])
        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.lastDeliveredRunSequence, undefined)
        assert.equal(record?.pendingCompletions?.length, 1)

        harness.rootEntries.push(communicationEntry(harness.rootSends[0]!))
        await harness.coordinator.reconcileDeliveryReceipts(ROOT_PATH)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.lastDeliveredRunSequence,
            1
        )
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.pendingCompletions?.length,
            0
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('intent checkpoint failure keeps the outbox and never dispatches', async () => {
    const harness = createHarness()
    try {
        await spawn(harness, ROOT_PATH, 'worker')
        harness.failIntent = true
        harness.sessions.get('/root/worker')!.finishRun()
        await flushTimes(3)
        let record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(harness.rootSends.length, 0)
        assert.equal(record?.pendingCompletions?.length, 1)
        assert.equal(record?.lastDeliveredRunSequence, undefined)

        harness.failIntent = false
        await harness.coordinator.reconcileDeliveryReceipts(ROOT_PATH, {
            forceRetry: true,
        })
        record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(harness.rootSends.length, 1)
        assert.equal(record?.pendingCompletions?.length, 0)
        assert.equal(record?.lastDeliveredRunSequence, 1)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('receipt checkpoint failure rolls the watermark back and retries idempotently', async () => {
    const harness = createHarness()
    try {
        await spawn(harness, ROOT_PATH, 'worker')
        harness.failReceipt = true
        harness.sessions.get('/root/worker')!.finishRun()
        await flushTimes(4)
        let record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(harness.rootSends.length, 1)
        assert.equal(record?.lastDeliveredRunSequence, undefined)
        assert.equal(record?.pendingCompletions?.length, 1)

        harness.failReceipt = false
        await harness.coordinator.reconcileDeliveryReceipts(ROOT_PATH, {
            forceRetry: true,
        })
        record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(harness.rootSends.length, 1)
        assert.equal(record?.lastDeliveredRunSequence, 1)
        assert.equal(record?.pendingCompletions?.length, 0)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('idle child insertion rejection retains the pending result', async () => {
    const harness = createHarness()
    try {
        await spawn(harness, ROOT_PATH, 'parent')
        harness.sessions.get('/root/parent')!.finishRun()
        await flushTimes(2)
        await spawn(harness, '/root/parent' as AgentPath, 'worker')
        const parent = harness.sessions.get('/root/parent')!
        parent.rejectNextSend = new Error('native send exploded')
        harness.sessions.get('/root/parent/worker')!.finishRun()
        await flushTimes(6)

        let record = harness.coordinator.getRecordByPath(
            '/root/parent/worker' as AgentPath
        )
        assert.equal(record?.lastDeliveredRunSequence, undefined)
        assert.equal(record?.pendingCompletions?.length, 1)

        await harness.coordinator.reconcileDeliveryReceipts(
            '/root/parent' as AgentPath,
            { forceRetry: true }
        )
        record = harness.coordinator.getRecordByPath(
            '/root/parent/worker' as AgentPath
        )
        assert.equal(record?.lastDeliveredRunSequence, 1)
        assert.equal(record?.pendingCompletions?.length, 0)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('a restored recipient envelope is acknowledged without resending', async () => {
    const harness = createHarness()
    try {
        const parent = new FakeSession(
            'parent',
            {
                ...restored('/root/parent', '/root'),
                path: '/root/parent' as AgentPath,
                parentId: null,
                residency: 'unloaded',
                model: 'test-provider/test-model',
            } as unknown as AgentRecord,
            [communicationEntry({ id: 'comm-1' } as InterAgentCommunication)]
        )
        harness.sessions.set('/root/parent', parent)
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                restored('/root/parent', '/root'),
                restored('/root/parent/worker', '/root/parent', {
                    pending: [
                        {
                            id: 'comm-1',
                            runSequence: 1,
                            payload: 'worker result',
                        },
                    ],
                }),
            ],
        })
        await harness.coordinator.reconcileDeliveryReceipts(
            '/root/parent' as AgentPath
        )
        assert.equal(parent.customMessages.length, 0)
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.lastDeliveredRunSequence,
            1
        )
        assert.equal(
            harness.coordinator.getRecordByPath(
                '/root/parent/worker' as AgentPath
            )?.pendingCompletions?.length,
            0
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('unknown probe state never authorizes force retry', async () => {
    const harness = createHarness()
    try {
        harness.rootProbe = 'throw'
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                restored('/root/worker', '/root', {
                    pending: [
                        {
                            id: 'comm-1',
                            runSequence: 1,
                            payload: 'worker result',
                        },
                    ],
                }),
            ],
        })
        await harness.coordinator.reconcileDeliveryReceipts(ROOT_PATH, {
            forceRetry: true,
        })
        assert.equal(harness.rootSends.length, 0)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.pendingCompletions?.length,
            1
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('detach fences delivery without discarding the outbox', async () => {
    const harness = createHarness()
    try {
        await spawn(harness, ROOT_PATH, 'worker')
        harness.coordinator.detachDelivery()
        harness.sessions.get('/root/worker')!.finishRun()
        await flushTimes(4)
        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(harness.rootSends.length, 0)
        assert.equal(record?.pendingCompletions?.length, 1)
        await harness.coordinator.shutdown()
        const state = harness.coordinator.serialize('root-session')
        assert.equal(
            state.agents.find((agent) => agent.path === '/root/worker')
                ?.pendingCompletions?.length,
            1
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('idle child acceptance does not wait for the model run', async () => {
    const harness = createHarness()
    try {
        await spawn(harness, ROOT_PATH, 'parent')
        harness.sessions.get('/root/parent')!.finishRun()
        await flushTimes(2)
        await spawn(harness, '/root/parent' as AgentPath, 'worker')
        const parent = harness.sessions.get('/root/parent')!
        parent.holdRun = true
        harness.sessions.get('/root/parent/worker')!.finishRun()
        await flushTimes(6)

        assert.equal(parent.isStreaming, true)
        const record = harness.coordinator.getRecordByPath(
            '/root/parent/worker' as AgentPath
        )
        assert.equal(record?.lastDeliveredRunSequence, 1)
        assert.equal(record?.pendingCompletions?.length, 0)
        assert.ok(parent.customMessages.length > 0)
        parent.finishRun()
        await flushTimes(2)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('a child terminal idle boundary reconciles an unobserved dispatch', async () => {
    const harness = createHarness()
    try {
        await spawn(harness, ROOT_PATH, 'parent')
        harness.sessions.get('/root/parent')!.finishRun()
        await flushTimes(2)
        await spawn(harness, '/root/parent' as AgentPath, 'worker')
        const parent = harness.sessions.get('/root/parent')!
        parent.holdRun = true
        parent.insertOnSend = false
        harness.sessions.get('/root/parent/worker')!.finishRun()
        await flushTimes(4)

        let record = harness.coordinator.getRecordByPath(
            '/root/parent/worker' as AgentPath
        )
        assert.equal(record?.pendingCompletions?.length, 1)
        assert.equal(parent.customMessages.length, 2)

        parent.insertOnSend = true
        parent.finishRun()
        await new Promise((resolve) => setTimeout(resolve, 5))
        await flushTimes(6)
        record = harness.coordinator.getRecordByPath(
            '/root/parent/worker' as AgentPath
        )
        assert.equal(record?.lastDeliveredRunSequence, 1)
        assert.equal(record?.pendingCompletions?.length, 0)
        assert.equal(parent.customMessages.length, 3)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('failed receipt checkpoint preserves a newer completion queued during the await', async () => {
    const harness = createHarness()
    try {
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                restored('/root/worker', '/root', {
                    pending: [
                        {
                            id: 'comm-1',
                            runSequence: 1,
                            payload: 'first result',
                        },
                    ],
                }),
            ],
        })
        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )!
        const internal = harness.coordinator as unknown as {
            queuePendingCompletion(
                childId: string,
                sequence: number,
                communication: InterAgentCommunication
            ): unknown
        }
        let queued = false
        harness.failReceipt = true
        harness.beforeCheckpoint = (event) => {
            if (event.reason !== 'receipt-accepted' || queued) return
            queued = true
            internal.queuePendingCompletion(record.id, 2, {
                id: 'comm-2',
                kind: 'result',
                messageType: 'FINAL_ANSWER',
                author: '/root/worker',
                recipient: '/root',
                payload: 'newer result',
                triggerTurn: true,
            } as InterAgentCommunication)
        }
        await harness.coordinator.reconcileDeliveryReceipts(ROOT_PATH, {
            forceRetry: true,
        })
        const after = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(harness.rootSends.length, 1)
        assert.equal(after?.lastDeliveredRunSequence, undefined)
        assert.deepEqual(
            after?.pendingCompletions?.map((item) => item.runSequence),
            [1, 2]
        )
        assert.deepEqual(
            after?.pendingCompletions?.map((item) => item.communicationId),
            ['comm-1', 'comm-2']
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})
