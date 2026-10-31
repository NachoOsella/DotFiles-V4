import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { AgentRecord } from '../domain/agent-record.ts'

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
    readonly model: { provider: string; id: string }
    readonly thinkingLevel: AgentRecord['thinkingLevel']
    readonly activeTools: string[]
    readonly messages: unknown[] = []
    readonly extensionRunner = { emit: async () => undefined }
    readonly listeners = new Set<(event: Record<string, unknown>) => void>()
    disposed = false
    isStreaming = false
    sendGate: Deferred<void> | undefined
    sentWhileDisposed = false
    sends = 0
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
    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }
    emit(event: Record<string, unknown>): void {
        for (const listener of [...this.listeners]) listener(event)
    }
    async sendCustomMessage(): Promise<void> {
        this.sends += 1
        if (this.disposed) this.sentWhileDisposed = true
        if (this.sendGate) await this.sendGate.promise
    }
    finishRun(): void {
        this.isStreaming = false
        this.emit({ type: 'agent_settled' })
    }
    abort(): Promise<void> {
        this.isStreaming = false
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
        return {
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            userMessages: 1,
            assistantMessages: 1,
            toolResults: 0,
        }
    }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function flushTimes(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) await flush()
}

function createHarness() {
    const sessions = new Map<string, FakeSession>()
    const makeRuntime = (record: AgentRecord): AgentRuntime => {
        const existing = sessions.get(record.path as string)
        const session = existing ?? new FakeSession(record.path, record)
        sessions.set(record.path as string, session)
        return makeAgentRuntime({
            path: record.path,
            session: session as unknown as AgentSession,
            runSequence: record.runSequence,
        })
    }
    const coordinator = new SubagentCoordinator({
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            maxAgents: 8,
            maxLoadedAgents: 1,
            maxConcurrentExecutions: 4,
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
        rootEndpoint: { path: ROOT_PATH, async send() {} },
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
    })
    return { coordinator, sessions }
}

function restored(path: string) {
    return {
        id: path.replaceAll('/', '_'),
        path,
        parentPath: '/root',
        rootSessionId: 'root-session',
        sessionId: `old-${path}`,
        sessionFile: `/tmp/${path.replaceAll('/', '_')}.jsonl`,
        cwd: '/repo',
        role: 'default',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium' as const,
        activeTools: [] as string[],
        status: 'Completed',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        runSequence: 1,
    }
}

test('send does not reach a runtime disposed by concurrent LRU pressure', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        harness.sessions.get('/root/a')!.finishRun()
        await flushTimes(2)
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [restored('/root/b')],
        })

        const a = harness.sessions.get('/root/a')!
        const gate = new Deferred<void>()
        a.sendGate = gate
        const first = harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/a',
            message: 'first',
        })
        await flushTimes(2)
        const second = harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/a',
            message: 'second',
        })
        await flushTimes(2)
        const loadB = harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/b',
            message: 'load b',
        })
        await flushTimes(3)
        assert.equal(a.disposed, false)

        gate.resolve()
        await first
        await second
        await loadB
        assert.equal(a.sentWhileDisposed, false)
        // Spawn NEW_TASK plus the two send_message deliveries.
        assert.equal(a.sends, 3)
        assert.equal(a.disposed, true)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('follow-up does not reach a runtime disposed by concurrent LRU pressure', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const a = harness.sessions.get('/root/a')!
        a.finishRun()
        await flushTimes(2)
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [restored('/root/b')],
        })

        a.isStreaming = true
        const gate = new Deferred<void>()
        a.sendGate = gate
        const follow = harness.coordinator.followup({
            caller: ROOT_PATH,
            target: '/root/a',
            message: 'while streaming',
        })
        await flushTimes(2)
        const loadB = harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/b',
            message: 'load b',
        })
        await flushTimes(3)
        assert.equal(a.disposed, false)

        gate.resolve()
        await follow
        a.finishRun()
        await flushTimes(2)
        await loadB
        assert.equal(a.sentWhileDisposed, false)
        assert.equal(a.disposed, true)
    } finally {
        await harness.coordinator.shutdown()
    }
})
