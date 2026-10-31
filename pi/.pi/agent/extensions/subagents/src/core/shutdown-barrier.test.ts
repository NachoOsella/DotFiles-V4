import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
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
    disposeError: Error | undefined
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
    stats = {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolResults: 0,
    }
    private run = new Deferred<void>()

    constructor(id = 'child') {
        this.sessionId = `session-${id}`
        this.sessionFile = `/tmp/${id}.jsonl`
    }

    subscribe(listener: (event: Record<string, unknown>) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: Record<string, unknown>): void {
        for (const listener of [...this.listeners]) listener(event)
    }

    async sendCustomMessage(): Promise<void> {
        this.isStreaming = true
        await this.run.promise
    }

    abort(): Promise<void> {
        this.stats = {
            tokens: { input: 42, output: 3, cacheRead: 0, cacheWrite: 0 },
            cost: 0.5,
            userMessages: 1,
            assistantMessages: 1,
            toolResults: 0,
        }
        this.isStreaming = false
        this.run.resolve(undefined)
        this.emit({ type: 'agent_settled' })
        return Promise.resolve()
    }

    dispose(): void {
        this.disposed = true
        this.run.resolve(undefined)
        if (this.disposeError) throw this.disposeError
    }

    getActiveToolNames(): string[] {
        return this.activeTools
    }

    getLastAssistantText(): string {
        return 'partial'
    }

    getSessionStats() {
        return this.stats
    }
}

test('shutdown is an idempotent barrier that captures abort-time usage', async () => {
    const session = new FakeSession()
    const runtime: AgentRuntime = makeAgentRuntime({
        path: '/root/worker' as never,
        session: session as unknown as AgentSession,
    })
    const coordinator = new SubagentCoordinator({
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            maxAgents: 4,
            maxLoadedAgents: 4,
            maxConcurrentExecutions: 4,
        },
        getRootSnapshot: () => ({
            path: ROOT_PATH,
            cwd: '/repo',
            model: { provider: 'test-provider', id: 'test-model' },
            thinkingLevel: 'medium',
            activeTools: [],
            contextEntries: [],
            sessionId: 'root-session',
        }),
        rootEndpoint: { path: ROOT_PATH, async send() {} },
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({}) as never,
        buildTools: () => [],
        sessionFactory: {
            async create(record: AgentRecord) {
                return { ...runtime, path: record.path }
            },
            async open(record: AgentRecord) {
                return { ...runtime, path: record.path }
            },
        },
    })
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'worker',
        message: 'work',
    })
    const first = coordinator.shutdown()
    const second = coordinator.shutdown()
    assert.equal(first, second)
    await first

    const state = coordinator.serialize('root-session')
    const worker = state.agents.find((agent) => agent.path === '/root/worker')
    assert.equal(worker?.status, 'Interrupted')
    assert.equal(worker?.usage?.input, 42)
    assert.equal(worker?.usage?.cost, 0.5)
    assert.equal(session.disposed, true)
})

test('shutdown settles every runtime and cleans up after a finalizer failure', async () => {
    const sessions = new Map<string, FakeSession>()
    const makeRuntime = (record: AgentRecord): AgentRuntime => {
        const session = sessions.get(record.path as string) ?? new FakeSession()
        sessions.set(record.path as string, session)
        return makeAgentRuntime({
            path: record.path,
            session: session as unknown as AgentSession,
        })
    }
    const coordinator = new SubagentCoordinator({
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            maxAgents: 4,
            maxLoadedAgents: 4,
            maxConcurrentExecutions: 4,
        },
        getRootSnapshot: () => ({
            path: ROOT_PATH,
            cwd: '/repo',
            model: { provider: 'test-provider', id: 'test-model' },
            thinkingLevel: 'medium',
            activeTools: [],
            contextEntries: [],
            sessionId: 'root-session',
        }),
        rootEndpoint: { path: ROOT_PATH, async send() {} },
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({}) as never,
        buildTools: () => [],
        sessionFactory: {
            async create(record: AgentRecord) {
                return makeRuntime(record)
            },
            async open(record: AgentRecord) {
                return makeRuntime(record)
            },
        },
    })
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'a',
    })
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'b',
        message: 'b',
    })
    const a = sessions.get('/root/a')!
    const b = sessions.get('/root/b')!
    a.disposeError = new Error('finalizer failed')
    const waiting = coordinator.wait({
        caller: '/root/a' as never,
        timeoutMs: 60_000,
    })
    const first = coordinator.shutdown()
    const second = coordinator.shutdown()
    assert.equal(first, second)
    await assert.rejects(first, /finalizer failed/)
    await assert.rejects(second, /finalizer failed/)
    await assert.rejects(waiting, /Wait cancelled/)
    assert.equal(a.disposed, true)
    assert.equal(b.disposed, true)
})
