import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import {
    DEFAULT_SUBAGENTS_CONFIG,
    type CodexSubagentsConfig,
} from '../config/config.ts'
import {
    MAX_RETAINED_TASKS_PER_AGENT,
    SubagentCoordinator,
} from './coordinator.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { InterAgentCommunication } from '../domain/communication.ts'

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

    async sendCustomMessage(
        message: unknown,
        options?: { triggerTurn?: boolean }
    ): Promise<void> {
        this.customMessages.push(message)
        if (!options?.triggerTurn) return
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

function createHarness(limits?: CodexSubagentsConfig['limits']) {
    const sessions = new Map<string, FakeSession>()
    const rootMessages: InterAgentCommunication[] = []
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
            maxAgents: 8,
            maxLoadedAgents: 8,
            maxConcurrentExecutions: 4,
            ...(limits ? { limits } : {}),
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
    })
    return { coordinator, sessions, rootMessages }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
async function flushTimes(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) await flush()
}

test('spawn creates a bounded task that completes with resultRef and correlation meta', async () => {
    const harness = createHarness()
    try {
        const payload = `line one\n${'x'.repeat(400)}\nline three`
        const spawnResult = await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: payload,
        })
        const path = '/root/worker' as AgentPath
        let task = harness.coordinator.tasks(path)[0]
        assert.equal(spawnResult.taskId, task?.id)
        assert.ok(task)
        assert.equal(task.kind, 'spawn')
        assert.equal(task.submittedBy, ROOT_PATH)
        assert.equal(task.status, 'active')
        assert.equal(task.runSequence, 1)
        assert.ok(task.objective.length <= 200)
        assert.ok(!task.objective.includes('\n'))
        assert.ok(!task.objective.includes('line three'))
        assert.equal(task.objective.includes('x'.repeat(400)), false)

        harness.sessions.get(path)!.finishRun()
        await flushTimes(4)
        task = harness.coordinator.tasks(path)[0]!
        assert.equal(task.status, 'completed')
        assert.equal(task.completedAt !== undefined, true)
        assert.equal(task.resultRef, '/tmp/_root_worker.jsonl')

        const completion = harness.rootMessages.at(-1)
        assert.equal(completion?.meta?.taskId, task.id)
        assert.equal(completion?.meta?.runSequence, 1)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('followup creates a new task without mutating the prior completed task', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'first assignment',
        })
        const path = '/root/worker' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(4)
        const first = harness.coordinator.tasks(path)[0]!
        const firstCompletedAt = first.completedAt

        const followupResult = await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: path,
            message: 'second assignment',
        })
        const afterFollowup = harness.coordinator.tasks(path)
        assert.equal(followupResult.taskId, afterFollowup[0]?.id)
        assert.equal(afterFollowup.length, 2)
        assert.equal(afterFollowup[0]!.kind, 'followup')
        assert.equal(afterFollowup[0]!.status, 'active')
        assert.equal(afterFollowup[0]!.runSequence, 2)
        assert.equal(afterFollowup[1]!.id, first.id)
        assert.equal(afterFollowup[1]!.status, 'completed')
        assert.equal(afterFollowup[1]!.completedAt, firstCompletedAt)

        harness.sessions.get(path)!.finishRun()
        await flushTimes(4)
        const completed = harness.coordinator.tasks(path)
        assert.deepEqual(
            completed.map((task) => task.status),
            ['completed', 'completed']
        )
        const completion = harness.rootMessages.at(-1)
        assert.equal(completion?.meta?.taskId, completed[0]!.id)
        assert.equal(completion?.meta?.runSequence, 2)
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('tasks read model is sorted newest first and list exposes current task', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'first',
        })
        const path = '/root/worker' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: path,
            message: 'second',
        })
        const tasks = harness.coordinator.tasks(path)
        assert.equal(tasks[0]!.kind, 'followup')
        assert.equal(tasks[1]!.kind, 'spawn')
        const entry = harness.coordinator
            .list(ROOT_PATH)
            .find((agent) => agent.path === path)
        assert.equal(entry?.currentTask?.id, tasks[0]!.id)
        assert.equal(entry?.currentTask?.objective, 'second')
        harness.sessions.get(path)!.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('tasks and archivedAt survive a version 3 serialize and restore', async () => {
    const harness = createHarness()
    let snapshot
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'durable task',
        })
        const path = '/root/worker' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(3)
        await harness.coordinator.archive(ROOT_PATH, path)
        snapshot = harness.coordinator.serialize('root-session')
        assert.equal(snapshot.version, 3)
        assert.equal(snapshot.tasks[0]?.objective, 'durable task')
        assert.equal(
            snapshot.agents.find((agent) => agent.path === path)?.archivedAt !==
                undefined,
            true
        )
    } finally {
        await harness.coordinator.shutdown()
    }
    const restored = createHarness()
    try {
        restored.coordinator.restore(snapshot)
        const path = '/root/worker' as AgentPath
        assert.equal(restored.coordinator.tasks(path)[0]?.status, 'completed')
        assert.equal(
            restored.coordinator
                .list(ROOT_PATH)
                .some((agent) => agent.path === path),
            false
        )
        const included = restored.coordinator.list(ROOT_PATH, undefined, {
            includeArchived: true,
        })
        assert.equal(
            included.find((agent) => agent.path === path)?.archived,
            true
        )
    } finally {
        await restored.coordinator.shutdown()
    }
})

test('limit termination marks the correlated task failed with resultRef', async () => {
    const harness = createHarness({
        maxModelRequestsPerRun: 1,
        warnAtRatio: 0.8,
    })
    try {
        const spawnResult = await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'bounded work',
        })
        const path = '/root/worker' as AgentPath
        const session = harness.sessions.get(path)!
        session.emit({ type: 'turn_start' })
        session.emit({ type: 'turn_start' })
        await flushTimes(4)

        const task = harness.coordinator.tasks(path)[0]
        assert.equal(task?.id, spawnResult.taskId)
        assert.equal(task?.status, 'failed')
        assert.equal(task?.completedAt !== undefined, true)
        assert.equal(task?.resultRef, '/tmp/_root_worker.jsonl')
        assert.equal(
            harness.coordinator.getRecordByPath(path)?.limitReached?.kind,
            'requests'
        )
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('task history is capped while an active task survives pruning', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'spawn',
        })
        const path = '/root/worker' as AgentPath
        harness.sessions.get(path)!.finishRun()
        await flushTimes(2)
        const oldestId = harness.coordinator.tasks(path)[0]?.id
        for (let index = 0; index < 55; index += 1) {
            await harness.coordinator.followup({
                caller: ROOT_PATH,
                target: path,
                message: `followup ${index}`,
            })
            harness.sessions.get(path)!.finishRun()
            await flushTimes(1)
        }
        assert.equal(
            harness.coordinator.tasks(path).length,
            MAX_RETAINED_TASKS_PER_AGENT
        )
        assert.equal(
            harness.coordinator
                .tasks(path)
                .some((task) => task.id === oldestId),
            false
        )

        await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: path,
            message: 'active submission',
        })
        const tasks = harness.coordinator.tasks(path)
        assert.equal(tasks.length, MAX_RETAINED_TASKS_PER_AGENT)
        assert.equal(tasks[0]?.status, 'active')
        assert.equal(tasks[0]?.objective, 'active submission')
        const snapshot = harness.coordinator.serialize('root-session')
        const persisted = snapshot.tasks.filter(
            (task) => task.agentPath === path
        )
        assert.equal(persisted.length, MAX_RETAINED_TASKS_PER_AGENT)
        assert.equal(
            persisted.some((task) => task.id === tasks[0]?.id),
            true
        )
        harness.sessions.get(path)!.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})
