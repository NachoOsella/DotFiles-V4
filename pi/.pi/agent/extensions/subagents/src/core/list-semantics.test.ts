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
import { AgentBlockedError } from '../domain/errors.ts'

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
    readonly customMessages: unknown[] = []
    private run = new Deferred<void>()

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
        await this.run.promise
    }

    abort(): Promise<void> {
        this.isStreaming = false
        this.run.resolve(undefined)
        this.emit({ type: 'agent_settled' })
        return Promise.resolve()
    }

    finishRun(): void {
        this.isStreaming = false
        this.run.resolve(undefined)
        this.emit({ type: 'agent_settled' })
    }

    dispose(): void {
        this.disposed = true
        this.run.resolve(undefined)
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

function createHarness(
    waitOverride?: CodexSubagentsConfig['wait'],
    options?: { blocked?: Set<string> }
) {
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
            ...(waitOverride ? { wait: waitOverride } : {}),
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
                if (options?.blocked?.has(record.path as string)) {
                    throw new AgentBlockedError(
                        record.path as string,
                        'the recorded session file does not exist',
                        'Restore the session file or start a new agent; no replacement session is created.'
                    )
                }
                return makeRuntime(record)
            },
        },
    })
    return { coordinator, sessions, rootMessages }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function restoredAgent(
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

function listed(
    coordinator: SubagentCoordinator,
    path: AgentPath
): ReturnType<SubagentCoordinator['list']>[number] | undefined {
    return coordinator.list(ROOT_PATH).find((agent) => agent.path === path)
}

test('pending mail means the outbox, pending activity means WaitHub', async () => {
    const harness = createHarness()
    try {
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [
                restoredAgent('/root/parent', '/root'),
                restoredAgent('/root/parent/worker', '/root/parent', [
                    { id: 'comm-1', payload: 'result' },
                ]),
            ],
        })
        const parentPath = '/root/parent' as AgentPath
        let parent = listed(harness.coordinator, parentPath)
        assert.equal(parent?.hasPendingMail, true)
        assert.equal(parent?.hasPendingActivity, false)

        await harness.coordinator.retryPendingCompletions(parentPath)
        await flush()
        parent = listed(harness.coordinator, parentPath)
        assert.equal(parent?.hasPendingMail, false)
        assert.equal(parent?.hasPendingActivity, true)

        const wait = await harness.coordinator.wait({ caller: parentPath })
        assert.equal(wait.wakeReason, 'mailbox')
        parent = listed(harness.coordinator, parentPath)
        assert.equal(parent?.hasPendingActivity, false)

        await harness.coordinator.sendMessage({
            caller: ROOT_PATH,
            target: parentPath,
            message: 'note',
        })
        parent = listed(harness.coordinator, parentPath)
        assert.equal(parent?.hasPendingMail, false)
        assert.equal(parent?.hasPendingActivity, true)
        const second = await harness.coordinator.wait({ caller: parentPath })
        assert.equal(second.wakeReason, 'mailbox')
        assert.equal(
            listed(harness.coordinator, parentPath)?.hasPendingActivity,
            false
        )
        harness.sessions.get('/root/parent')?.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('wait reports steer wakes separately from mailbox wakes', async () => {
    const harness = createHarness()
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'work',
        })
        const worker = '/root/worker' as AgentPath
        const waiting = harness.coordinator.wait({ caller: worker })
        await flush()
        await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: worker,
            message: 'steer',
        })
        const result = await waiting
        assert.deepEqual(result, {
            message: 'Wait interrupted by new input.',
            timedOut: false,
            wakeReason: 'steer',
        })
        harness.sessions.get(worker)?.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('wait reports timeout distinctly and preserves existing fields', async () => {
    const harness = createHarness({
        defaultTimeoutMs: 5,
        minTimeoutMs: 1,
        maxTimeoutMs: 100,
    })
    try {
        await harness.coordinator.spawn({
            caller: ROOT_PATH,
            taskName: 'worker',
            message: 'work',
        })
        const result = await harness.coordinator.wait({
            caller: '/root/worker' as AgentPath,
            timeoutMs: 1,
        })
        assert.equal(result.wakeReason, 'timeout')
        assert.equal(result.timedOut, true)
        assert.match(result.message, /Wait timed out/)
        harness.sessions.get('/root/worker')?.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})

test('blocked reopen preserves its typed error and marks list truthfully', async () => {
    const blocked = new Set(['/root/blocked'])
    const harness = createHarness(undefined, { blocked })
    try {
        harness.coordinator.restore({
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: Date.now(),
            agents: [restoredAgent('/root/blocked', '/root')],
        })
        const path = '/root/blocked' as AgentPath
        await assert.rejects(
            harness.coordinator.followup({
                caller: ROOT_PATH,
                target: path,
                message: 'continue',
            }),
            (error: unknown) =>
                error instanceof AgentBlockedError &&
                error.code === 'agent_blocked' &&
                /session file does not exist/.test(error.reason) &&
                /Restore the session file/.test(error.guidance)
        )
        let entry = listed(harness.coordinator, path)
        assert.equal(entry?.status, 'Completed')
        assert.equal(entry?.residency, 'unloaded')
        assert.match(entry?.blockedReason ?? '', /session file does not exist/)

        const snapshot = harness.coordinator.serialize('root-session')
        assert.equal(
            snapshot.agents.find((agent) => agent.path === '/root/blocked')
                ?.blocked?.code,
            'agent_blocked'
        )
        const restored = createHarness()
        try {
            restored.coordinator.restore(snapshot)
            assert.match(
                listed(restored.coordinator, path)?.blockedReason ?? '',
                /session file does not exist/
            )
        } finally {
            await restored.coordinator.shutdown()
        }

        blocked.clear()
        await harness.coordinator.followup({
            caller: ROOT_PATH,
            target: path,
            message: 'continue',
        })
        entry = listed(harness.coordinator, path)
        assert.equal(entry?.blockedReason, undefined)
        assert.equal(entry?.status, 'Running')
        harness.sessions.get('/root/blocked')?.finishRun()
    } finally {
        await harness.coordinator.shutdown()
    }
})
