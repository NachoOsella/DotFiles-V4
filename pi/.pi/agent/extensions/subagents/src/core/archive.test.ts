import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { AgentArchivedError, SubagentCoordinator } from './coordinator.ts'
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
    readonly model = { provider: 'test-provider', id: 'test-model' }
    readonly thinkingLevel = 'medium' as const
    readonly activeTools: string[] = []
    readonly messages: unknown[] = []
    readonly extensionRunner = { emit: async () => undefined }
    readonly listeners = new Set<(event: Record<string, unknown>) => void>()
    isStreaming = false
    disposed = false
    customMessages: unknown[] = []
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
        return {
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            userMessages: 1,
            assistantMessages: 1,
            toolResults: 0,
        }
    }
}

function createHarness(options?: { maxAgents?: number }) {
    const sessions = new Map<string, FakeSession>()
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
    const coordinator = new SubagentCoordinator({
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            maxAgents: options?.maxAgents ?? 8,
            maxLoadedAgents: 8,
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function flushTimes(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) await flush()
}

function restored(
    path: string,
    parentPath: string,
    pending?: readonly { id: string; payload: string }[]
) {
    return {
        id: path.replaceAll('/', '_'),
        path,
        parentPath,
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
        ...(pending
            ? {
                  pendingCompletions: pending.map((item) => ({
                      communicationId: item.id,
                      runSequence: 1,
                      author: path,
                      recipient: parentPath,
                      payload: item.payload,
                  })),
              }
            : {}),
    }
}

test('archive frees quota, hides by default, and keeps the path non-reusable', async () => {
    const harness = createHarness({ maxAgents: 1 })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const path = '/root/a' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        await assert.rejects(
            harness.coordinator.spawn({
                caller: ROOT_PATH,
                taskName: 'b',
                message: 'b',
            }),
            /Agent spawn rejected/
        )

        const archived = await harness.coordinator.archive(ROOT_PATH, path)
        assert.equal(archived.path, path)
        assert.equal(typeof archived.archivedAt, 'number')
        assert.equal(
            harness.coordinator
                .list(ROOT_PATH)
                .some((agent) => agent.path === path),
            false
        )
        const included = harness.coordinator.list(ROOT_PATH, undefined, {
            includeArchived: true,
        })
        const row = included.find((agent) => agent.path === path)
        assert.equal(row?.archived, true)
        assert.equal(row?.archivedAt, archived.archivedAt)
        assert.equal(row?.currentTask?.objective, 'a')

        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'b',
            message: 'b',
        })
        await assert.rejects(
            harness.coordinator.spawn({
                caller: ROOT_PATH,
                taskName: 'a',
                message: 'again',
            }),
            /Agent already exists/
        )
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, path),
            /already archived/
        )
        harness.sessions.get('/root/b')?.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('archived agents reject messaging, follow-up, interrupt and load', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const path = '/root/a' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        await harness.coordinator.archive(ROOT_PATH, path)

        for (const operation of [
            () =>
                harness.coordinator.sendMessage({
                    caller: ROOT_PATH,
                    target: path,
                    message: 'message',
                }),
            () =>
                harness.coordinator.followup({
                    caller: ROOT_PATH,
                    target: path,
                    message: 'followup',
                }),
            () =>
                harness.coordinator.interrupt({
                    caller: ROOT_PATH,
                    target: path,
                }),
        ]) {
            await assert.rejects(
                operation(),
                (error: unknown) =>
                    error instanceof AgentArchivedError &&
                    error.code === 'agent_archived'
            )
        }
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('archive refuses non-terminal targets, root, and pending completions', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'running',
            message: 'running',
        })
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, '/root/running'),
            /not terminal/
        )
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, ROOT_PATH),
            /root cannot be archived/
        )
        harness.sessions.get('/root/running')?.finishRun()
        await flushTimes(3)

        harness.coordinator.restore({
            version: 3,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                restored('/root/parent', '/root'),
                restored('/root/parent/worker', '/root/parent', [
                    { id: 'comm-1', payload: 'pending' },
                ]),
            ],
            tasks: [],
        })
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, '/root/parent'),
            /undelivered completion still names/
        )
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, '/root/parent/worker'),
            /still owns an undelivered completion/
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('unarchive restores visibility and usability with the same identity', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const path = '/root/a' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        const originalId = harness.coordinator.getRecordByPath(path)?.id
        await harness.coordinator.archive(ROOT_PATH, path)
        assert.equal(
            harness.coordinator
                .list(ROOT_PATH)
                .some((agent) => agent.path === path),
            false
        )
        await assert.rejects(
            harness.coordinator.sendMessage({
                caller: ROOT_PATH,
                target: path,
                message: 'blocked',
            }),
            /agent_archived/
        )

        const result = await harness.coordinator.unarchive(ROOT_PATH, path)
        assert.equal(result.path, path)
        assert.equal(result.archived, false)
        assert.equal(result.archivedAt, undefined)
        const row = harness.coordinator
            .list(ROOT_PATH)
            .find((agent) => agent.path === path)
        assert.equal(row?.archived, false)
        assert.equal(harness.coordinator.getRecordByPath(path)?.id, originalId)

        await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: path,
            message: 'usable again',
        })
        assert.equal(
            harness.coordinator.getRecordByPath(path)?.status._tag,
            'Running'
        )
        harness.sessions.get(path)?.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('archive refuses a terminal record while its run is still tracked', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const path = '/root/a' as AgentPath
        const record = harness.coordinator.getRecordByPath(path)!
        const internal = harness.coordinator as unknown as {
            records: Map<string, AgentRecord>
        }
        internal.records.set(record.id, {
            ...record,
            status: { _tag: 'Completed', message: 'racy terminal' },
        })
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, path),
            /still settling its final run/
        )
        harness.sessions.get(path)?.finishRun()
        await flushTimes(3)
        await harness.coordinator.archive(ROOT_PATH, path)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('archive refuses while a descendant is non-terminal, then permits it', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'parent',
            message: 'parent',
        })
        const parent = '/root/parent' as AgentPath
        harness.sessions.get(parent)!.finishRun()
        await flushTimes(2)
        await harness.coordinator.spawn({
            caller: parent,
            taskName: 'child',
            message: 'child',
        })
        const child = '/root/parent/child' as AgentPath
        await assert.rejects(
            harness.coordinator.archive(ROOT_PATH, parent),
            /live descendant/
        )
        harness.sessions.get(child)!.finishRun()
        await flushTimes(4)
        // The child result starts the idle parent. Settle that run before retrying.
        harness.sessions.get(parent)!.finishRun()
        await flushTimes(3)
        await harness.coordinator.archive(ROOT_PATH, parent)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('archive refuses while a runtime lease is held, then succeeds after release', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const path = '/root/a' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        const record = harness.coordinator.getRecordByPath(path)!
        const internal = harness.coordinator as unknown as {
            leaseRuntime(id: string): Promise<{ release(): void }>
        }
        const lease = await internal.leaseRuntime(record.id)
        try {
            await assert.rejects(
                harness.coordinator.archive(ROOT_PATH, path),
                /in-flight operation/
            )
        } finally {
            lease.release()
        }
        await harness.coordinator.archive(ROOT_PATH, path)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('archive writes the archived task status for an active orphan task', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'a',
            message: 'a',
        })
        const path = '/root/a' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        const internal = harness.coordinator as unknown as {
            createTask(args: {
                agentPath: string
                kind: 'spawn' | 'followup'
                submittedBy: string
                communicationId: string
                payload: string
            }): { id: string }
        }
        const active = internal.createTask({
            agentPath: path,
            kind: 'followup',
            submittedBy: ROOT_PATH,
            communicationId: 'manual-active',
            payload: 'orphan task',
        })
        await harness.coordinator.archive(ROOT_PATH, path)
        assert.equal(
            harness.coordinator
                .tasks(path)
                .find((task) => task.id === active.id)?.status,
            'archived'
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})
