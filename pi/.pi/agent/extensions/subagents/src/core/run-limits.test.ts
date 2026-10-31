import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import {
    DEFAULT_SUBAGENTS_CONFIG,
    type CodexSubagentsConfig,
} from '../config/config.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { InterAgentCommunication } from '../domain/communication.ts'
import type { SubagentEvent } from '../domain/events.ts'

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
        getBranch: () => this.entries,
        getEntries: () => this.entries,
    }
    readonly model = { provider: 'test-provider', id: 'test-model' }
    readonly thinkingLevel = 'medium' as const
    readonly activeTools: string[] = []
    readonly messages: unknown[] = []
    readonly extensionRunner = { emit: async () => undefined }
    readonly listeners = new Set<(event: Record<string, unknown>) => void>()
    isStreaming = false
    disposed = false
    abortCalls = 0
    holdAbort = false
    stats = {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolResults: 0,
    }
    private run: Deferred<void> | undefined

    constructor(id: string) {
        this.sessionId = `session-${id}`
        this.sessionFile = `/tmp/${id}.jsonl`
    }

    get isIdle(): boolean {
        return !this.isStreaming
    }

    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: Record<string, unknown>): void {
        for (const listener of [...this.listeners]) listener(event)
    }

    async sendCustomMessage(): Promise<void> {
        if (this.isStreaming) return
        this.isStreaming = true
        const run = new Deferred<void>()
        this.run = run
        await run.promise
    }

    abort(): Promise<void> {
        this.abortCalls += 1
        if (this.holdAbort) return Promise.resolve()
        this.isStreaming = false
        this.run?.resolve(undefined)
        this.run = undefined
        this.emit({ type: 'agent_settled' })
        return Promise.resolve()
    }

    finishRun(): void {
        this.isStreaming = false
        this.run?.resolve(undefined)
        this.run = undefined
        this.emit({ type: 'agent_settled' })
    }

    dispose(): void {
        this.disposed = true
        this.run?.resolve(undefined)
        this.run = undefined
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

interface TimerRecord {
    readonly callback: () => void
    readonly timeoutMs: number
    cleared: boolean
}

function createHarness(options?: { limits?: CodexSubagentsConfig['limits'] }) {
    const sessions = new Map<string, FakeSession>()
    const rootMessages: InterAgentCommunication[] = []
    const timers: TimerRecord[] = []
    const cleared: TimerRecord[] = []
    const events: SubagentEvent[] = []
    const makeRuntime = (record: AgentRecord): AgentRuntime => {
        const session =
            sessions.get(record.path as string) ??
            new FakeSession(record.path.replaceAll('/', '_'))
        sessions.set(record.path as string, session)
        return makeAgentRuntime({
            path: record.path,
            session: session as unknown as AgentSession,
            runSequence: record.runSequence,
        })
    }
    const config: CodexSubagentsConfig = {
        ...DEFAULT_SUBAGENTS_CONFIG,
        maxAgents: 8,
        maxLoadedAgents: 8,
        maxConcurrentExecutions: 4,
        ...(options?.limits ? { limits: options.limits } : {}),
    }
    const coordinator = new SubagentCoordinator({
        config,
        getRootSnapshot: () => ({
            path: ROOT_PATH,
            cwd: '/repo',
            model: { provider: 'test-provider', id: 'test-model' },
            thinkingLevel: 'medium',
            activeTools: ['spawn_agent'],
            contextEntries: [],
            sessionId: 'root-session',
        }),
        rootEndpoint: {
            path: ROOT_PATH,
            async send(communication) {
                rootMessages.push(communication)
            },
        },
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({}) as never,
        buildTools: () => [],
        sessionFactory: {
            async create(record) {
                return makeRuntime(record)
            },
            async open(record) {
                return makeRuntime(record)
            },
        },
        setTimer: (callback, timeoutMs) => {
            const record: TimerRecord = {
                callback,
                timeoutMs,
                cleared: false,
            }
            timers.push(record)
            return timers.length
        },
        clearTimer: (handle) => {
            const record = timers[Number(handle) - 1]
            if (!record) return
            record.cleared = true
            cleared.push(record)
        },
    })
    coordinator.onEvent((event) => events.push(event))
    return {
        coordinator,
        sessions,
        rootMessages,
        timers,
        cleared,
        events,
    }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function flushTimes(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) await flush()
}

async function spawn(harness: ReturnType<typeof createHarness>): Promise<void> {
    await harness.coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'worker',
        message: 'work',
    })
}

test('unlimited limits reproduce M1 admission and schedule no deadline', async () => {
    const harness = createHarness()
    try {
        assert.equal(harness.coordinator.limits().unlimited, true)
        assert.equal(harness.coordinator.limits().limit, undefined)
        await spawn(harness)
        assert.equal(harness.timers.length, 0)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Running'
        )
        harness.sessions.get('/root/worker')!.finishRun()
        await flushTimes(3)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Completed'
        )
        assert.equal(harness.coordinator.limits().consumed, 0)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('deadline aborts the run and settles as an explicit errored limit', async () => {
    const harness = createHarness({
        limits: {
            runDeadlineMs: 1_000,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        const timer = harness.timers[0]
        assert.ok(timer)
        assert.equal(timer.timeoutMs, 1_000)
        timer.callback()
        await flushTimes(4)

        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.status._tag, 'Errored')
        assert.equal(record?.limitReached?.kind, 'deadline')
        assert.match(record?.limitReached?.detail ?? '', /deadline_exceeded/)
        assert.equal(record?.lastDeliveredRunSequence, 1)
        assert.match(
            harness.rootMessages.at(-1)?.payload ?? '',
            /deadline_exceeded/
        )
        assert.equal(timer.cleared, true)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('request limit counts native turn_start events and aborts past the limit', async () => {
    const harness = createHarness({
        limits: {
            maxModelRequestsPerRun: 1,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        const session = harness.sessions.get('/root/worker')!
        session.emit({ type: 'turn_start' })
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Running'
        )
        session.emit({ type: 'turn_start' })
        await flushTimes(4)

        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.status._tag, 'Errored')
        assert.equal(record?.limitReached?.kind, 'requests')
        assert.match(
            record?.limitReached?.detail ?? '',
            /request_limit_exceeded/
        )
        assert.match(
            harness.rootMessages.at(-1)?.payload ?? '',
            /request_limit_exceeded/
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('shared token budget counts positive deltas once and terminates the overrun run', async () => {
    const harness = createHarness({
        limits: {
            maxTreeTokens: 10,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        const session = harness.sessions.get('/root/worker')!
        session.stats.tokens.input = 6
        session.emit({ type: 'turn_end' })
        session.emit({ type: 'turn_end' })
        assert.equal(harness.coordinator.limits().consumed, 6)
        assert.equal(harness.coordinator.limits().warning, false)

        session.stats.tokens.input = 11
        session.emit({ type: 'turn_end' })
        await flushTimes(4)

        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.status._tag, 'Errored')
        assert.equal(record?.limitReached?.kind, 'tokens')
        assert.match(
            record?.limitReached?.detail ?? '',
            /budget_exhausted_tokens/
        )
        const limits = harness.coordinator.limits()
        assert.equal(limits.consumed, 11)
        assert.equal(limits.exhausted, true)
        assert.equal(limits.remaining, 0)
        assert.ok(
            harness.events.some((event) => event._tag === 'LimitsChanged')
        )

        await assert.rejects(
            harness.coordinator.spawn({
                caller: ROOT_PATH,
                taskName: 'blocked',
                message: 'blocked',
            }),
            /budget_exhausted_tokens/
        )
        await assert.rejects(
            harness.coordinator.followup({
                caller: ROOT_PATH,
                target: '/root/worker',
                message: 'more',
            }),
            /budget_exhausted_tokens/
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('restored usage seeds the shared budget without double counting', async () => {
    const harness = createHarness({
        limits: {
            maxTreeTokens: 100,
            warnAtRatio: 0.8,
        },
    })
    try {
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                {
                    id: 'worker-id',
                    path: '/root/worker',
                    parentPath: '/root',
                    rootSessionId: 'root-session',
                    model: { provider: 'test-provider', id: 'test-model' },
                    activeTools: [],
                    status: 'Completed',
                    createdAt: Date.now(),
                    lastActivityAt: Date.now(),
                    runSequence: 1,
                    usage: {
                        provider: 'test-provider',
                        modelId: 'test-model',
                        input: 30,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: 0,
                        userMessages: 1,
                        assistantMessages: 1,
                        toolResults: 0,
                        toolCalls: [],
                    },
                },
            ],
        })
        assert.equal(harness.coordinator.limits().consumed, 30)
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                {
                    id: 'worker-id',
                    path: '/root/worker',
                    parentPath: '/root',
                    rootSessionId: 'root-session',
                    model: { provider: 'test-provider', id: 'test-model' },
                    activeTools: [],
                    status: 'Completed',
                    createdAt: Date.now(),
                    lastActivityAt: Date.now(),
                    runSequence: 1,
                    usage: {
                        provider: 'test-provider',
                        modelId: 'test-model',
                        input: 30,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: 0,
                        userMessages: 1,
                        assistantMessages: 1,
                        toolResults: 0,
                        toolCalls: [],
                    },
                },
            ],
        })
        assert.equal(harness.coordinator.limits().consumed, 30)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('limitReached survives serialize and restore', async () => {
    const harness = createHarness({
        limits: {
            maxModelRequestsPerRun: 1,
            warnAtRatio: 0.8,
        },
    })
    let snapshot
    try {
        await spawn(harness)
        harness.sessions.get('/root/worker')!.emit({ type: 'turn_start' })
        harness.sessions.get('/root/worker')!.emit({ type: 'turn_start' })
        await flushTimes(4)
        snapshot = harness.coordinator.serialize('root-session')
        assert.equal(
            snapshot.agents.find((agent) => agent.path === '/root/worker')
                ?.limitReached?.kind,
            'requests'
        )
    } finally {
        await harness.coordinator.shutdown()
    }
    const restored = createHarness()
    try {
        restored.coordinator.restore(snapshot)
        const record = restored.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.status._tag, 'Errored')
        assert.equal(record?.limitReached?.kind, 'requests')
    } finally {
        await restored.coordinator.shutdown()
    }
})

test('user interrupt with limits configured stays Interrupted, not limit errored', async () => {
    const harness = createHarness({
        limits: {
            runDeadlineMs: 10_000,
            maxModelRequestsPerRun: 10,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        await harness.coordinator.interrupt({
            caller: ROOT_PATH,
            target: '/root/worker',
        })
        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.status._tag, 'Interrupted')
        assert.equal(record?.limitReached, undefined)
        assert.equal(harness.timers[0]?.cleared, true)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('detach and shutdown clear live deadline timers', async () => {
    const harness = createHarness({
        limits: {
            runDeadlineMs: 10_000,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        assert.equal(harness.timers[0]?.cleared, false)
        harness.coordinator.detachDelivery()
        assert.equal(harness.timers[0]?.cleared, true)
        await harness.coordinator.shutdown()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('a settled run deadline cannot abort a later run of the same agent', async () => {
    const harness = createHarness({
        limits: {
            runDeadlineMs: 1_000,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        const session = harness.sessions.get('/root/worker')!
        const firstTimer = harness.timers[0]!
        session.finishRun()
        await flushTimes(3)
        assert.equal(firstTimer.cleared, true)

        await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: '/root/worker',
            message: 'second run',
        })
        const secondTimer = harness.timers[1]
        assert.ok(secondTimer)
        assert.notEqual(secondTimer, firstTimer)
        const aborts = session.abortCalls

        // The old deadline still fires in this test; the run sequence check
        // must prevent it from touching the newer run.
        firstTimer.callback()
        assert.equal(session.abortCalls, aborts)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Running'
        )
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.limitReached,
            undefined
        )
        session.finishRun()
        await flushTimes(3)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('rejected token-budget admission creates no record and leaks no permit', async () => {
    const harness = createHarness({
        limits: {
            maxTreeTokens: 10,
            warnAtRatio: 0.8,
        },
    })
    try {
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                {
                    id: 'existing-id',
                    path: '/root/existing',
                    parentPath: '/root',
                    rootSessionId: 'root-session',
                    model: { provider: 'test-provider', id: 'test-model' },
                    activeTools: [],
                    status: 'Completed',
                    createdAt: Date.now(),
                    lastActivityAt: Date.now(),
                    runSequence: 1,
                    usage: {
                        provider: 'test-provider',
                        modelId: 'test-model',
                        input: 10,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: 0,
                        userMessages: 1,
                        assistantMessages: 1,
                        toolResults: 0,
                        toolCalls: [],
                    },
                },
            ],
        })
        assert.equal(harness.coordinator.limits().exhausted, true)
        const limiter = (
            harness.coordinator as unknown as {
                limiter: { active: number; capacity: number }
            }
        ).limiter
        assert.equal(limiter.active, 0)

        await assert.rejects(
            harness.coordinator.spawn({
                caller: ROOT_PATH,
                taskName: 'blocked',
                message: 'blocked',
            }),
            /budget_exhausted_tokens/
        )
        assert.equal(
            harness.coordinator.getRecordByPath('/root/blocked' as AgentPath),
            undefined
        )
        assert.equal(harness.sessions.has('/root/blocked'), false)
        assert.equal(limiter.active, 0)
        assert.equal(limiter.capacity, 4)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('an already-limited run gets another abort nudge on later turns', async () => {
    const harness = createHarness({
        limits: {
            maxModelRequestsPerRun: 1,
            warnAtRatio: 0.8,
        },
    })
    try {
        await spawn(harness)
        const session = harness.sessions.get('/root/worker')!
        session.holdAbort = true
        session.emit({ type: 'turn_start' })
        session.emit({ type: 'turn_start' })
        assert.equal(session.abortCalls, 1)
        session.emit({ type: 'turn_start' })
        assert.equal(session.abortCalls, 2)
        assert.equal(
            harness.coordinator.getRecordByPath('/root/worker' as AgentPath)
                ?.status._tag,
            'Running'
        )

        session.holdAbort = false
        session.finishRun()
        await flushTimes(3)
        const record = harness.coordinator.getRecordByPath(
            '/root/worker' as AgentPath
        )
        assert.equal(record?.status._tag, 'Errored')
        assert.equal(record?.limitReached?.kind, 'requests')
    } finally {
        await harness.coordinator.shutdown()
    }
})
