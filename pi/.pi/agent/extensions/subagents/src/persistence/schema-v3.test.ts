import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentId, AgentPath, CommunicationId } from '../domain/ids.ts'
import {
    restoreAgentRecords,
    restoreAgentTasks,
    serializeAgentRecords,
} from './record-snapshot.ts'
import {
    isPersistedStateV3,
    parsePersistedStateV2,
    parsePersistedStateV3,
    type PersistedSubagentStateV2,
    type PersistedSubagentStateV3,
    type PersistedSubagentV2,
    type PersistedSubagentV3,
    type PersistedTaskV3,
} from './schema.ts'
import {
    SUBAGENTS_STATE_CUSTOM_TYPE,
    findLatestState,
    isPersistedState,
    parsePersistedState,
    readPersistedState,
} from './session-state.ts'

const PERSISTED_AT = 1_000

function agent(
    overrides: Partial<PersistedSubagentV2> = {}
): PersistedSubagentV2 {
    return {
        id: 'agent-a',
        path: '/root/child',
        parentPath: '/root',
        rootSessionId: 'root-session',
        model: { provider: 'test-provider', id: 'test-model' },
        activeTools: ['read'],
        status: 'Completed',
        createdAt: PERSISTED_AT,
        lastActivityAt: PERSISTED_AT + 1,
        runSequence: 1,
        ...overrides,
    }
}

function task(overrides: Partial<PersistedTaskV3> = {}): PersistedTaskV3 {
    return {
        id: 'task-1',
        agentPath: '/root/child',
        objective: 'Review the pending diff',
        kind: 'spawn',
        submittedBy: '/root',
        communicationId: 'comm-1',
        runSequence: 1,
        status: 'completed',
        createdAt: PERSISTED_AT,
        completedAt: PERSISTED_AT + 5,
        resultRef: 'agent-a:run-1',
        ...overrides,
    }
}

function v2(
    agents: readonly unknown[],
    persistedAt: unknown = PERSISTED_AT
): PersistedSubagentStateV2 {
    return {
        version: 2,
        rootSessionId: 'root-session',
        persistedAt: persistedAt as number,
        agents: agents as readonly PersistedSubagentV2[],
    }
}

function v3(
    agents: readonly unknown[],
    tasks: readonly unknown[] = [],
    persistedAt: unknown = PERSISTED_AT
): PersistedSubagentStateV3 {
    return {
        version: 3,
        rootSessionId: 'root-session',
        persistedAt: persistedAt as number,
        agents: agents as readonly PersistedSubagentV3[],
        tasks: tasks as readonly PersistedTaskV3[],
    }
}

describe('version 3 envelope', () => {
    it('roundtrips a canonical snapshot and keeps the strict guard honest', () => {
        const snapshot = v3([agent()], [task()])
        assert.equal(isPersistedStateV3(snapshot), true)
        assert.equal(isPersistedState(snapshot), true)
        assert.deepEqual(parsePersistedStateV3(snapshot), snapshot)
        assert.deepEqual(parsePersistedState(snapshot), snapshot)
    })

    it('rejects unknown versions and keeps V2 entry points v2-only', () => {
        const legacy = v2([agent()])
        assert.equal(parsePersistedStateV3(legacy), undefined)
        assert.equal(isPersistedStateV3(legacy), false)
        assert.equal(parsePersistedStateV2(v3([agent()])), undefined)
        for (const version of [1, 4, '3', undefined]) {
            assert.equal(
                parsePersistedStateV3({ ...v3([agent()]), version }),
                undefined
            )
            assert.equal(
                parsePersistedState({ ...v3([agent()]), version }),
                undefined
            )
        }
    })
})

describe('version 2 migration', () => {
    it('loads V2 in memory as V3 and reports migration', () => {
        const legacy = v2([agent({ task: 'kept task' })])
        assert.equal(isPersistedState(legacy), false)
        assert.equal(isPersistedStateV3(legacy), false)

        const read = readPersistedState(legacy)
        assert.ok(read)
        assert.equal(read.migratedFromVersion, 2)
        assert.equal(read.repaired, true)
        assert.equal(read.state.version, 3)
        assert.deepEqual(read.state.tasks, [])
        assert.deepEqual(read.state.agents, legacy.agents)
        assert.deepEqual(parsePersistedState(legacy), read.state)
    })

    it('rewrites a migrated checkpoint as version 3', () => {
        const legacy = v2([agent({ task: 'kept task' })])
        const records = restoreAgentRecords(
            JSON.parse(JSON.stringify(legacy)),
            'root-session'
        )
        const rewritten = serializeAgentRecords(records, 'root-session')
        assert.equal(rewritten.version, 3)
        assert.deepEqual(rewritten.tasks, [])
        assert.equal(isPersistedStateV3(rewritten), true)
        assert.equal(rewritten.agents[0]?.task, 'kept task')
    })

    it('finds and migrates V2 branch entries', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2([agent({ task: 'latest' })])
        )
        const found = findLatestState(session.getBranch())
        assert.equal(found?.version, 3)
        assert.equal(found?.agents[0]?.task, 'latest')
        assert.deepEqual(found?.tasks, [])
    })
})

describe('v3 repair', () => {
    it('drops unusable records and repairs recoverable fields per record', () => {
        const snapshot = v3(
            [
                agent(),
                agent({
                    id: 'broken',
                    path: '/root/broken',
                    model: {
                        provider: '',
                        id: '',
                    },
                }),
                agent(),
                agent({ id: 'other', path: '/root/child' }),
                {
                    ...agent({ id: 'archived', path: '/root/archived' }),
                    archivedAt: 'yesterday',
                },
                agent({ id: 'root-record', path: '/root' }),
            ],
            [
                task(),
                task({ id: 'missing-objective', objective: '' }),
                task({ id: 'root-task', agentPath: '/root' }),
                task({ id: 'bad-kind', kind: 'message' as never }),
                task({ id: 'task-1', objective: 'duplicate id' }),
                task({
                    id: 'task-2',
                    runSequence: '2' as never,
                    createdAt: Number.NaN,
                    completedAt: -1,
                    resultRef: 7 as never,
                }),
            ]
        )

        assert.equal(isPersistedStateV3(snapshot), false)
        assert.equal(isPersistedState(snapshot), false)
        const parsed = parsePersistedStateV3(snapshot)
        assert.ok(parsed)
        assert.deepEqual(
            parsed.agents.map((entry) => entry.id),
            ['agent-a', 'archived']
        )
        assert.equal(parsed.agents[1]?.archivedAt, PERSISTED_AT)
        assert.deepEqual(
            parsed.tasks.map((entry) => entry.id),
            ['task-1', 'task-2']
        )
        assert.equal(parsed.tasks[0]?.objective, 'Review the pending diff')
        const repaired = parsed.tasks[1]
        assert.equal(repaired?.runSequence, 0)
        assert.equal(repaired?.createdAt, PERSISTED_AT)
        assert.equal(repaired?.completedAt, PERSISTED_AT)
        assert.equal(repaired?.resultRef, undefined)
    })

    it('treats a missing task list as recoverable empty state', () => {
        const snapshot = {
            version: 3,
            rootSessionId: 'root-session',
            persistedAt: PERSISTED_AT,
            agents: [agent()],
        }
        assert.equal(isPersistedStateV3(snapshot), false)
        const parsed = parsePersistedStateV3(snapshot)
        assert.deepEqual(parsed?.tasks, [])
    })

    it('rejects unusable envelopes without rejecting old checkpoints', () => {
        for (const value of [
            null,
            undefined,
            42,
            'snapshot',
            [],
            { version: 3, rootSessionId: 'root-session' },
            { version: 3, persistedAt: 1, agents: [] },
        ]) {
            assert.equal(parsePersistedStateV3(value), undefined)
            assert.equal(parsePersistedState(value), undefined)
        }
        const legacy = v2([], PERSISTED_AT)
        assert.equal(isPersistedState(legacy), false)
        assert.equal(parsePersistedState(legacy)?.version, 3)
    })
})

describe('pending completion correlation', () => {
    const meta = {
        model: 'test-provider/test-model',
        taskId: 'task-1',
        runSequence: 7,
        fullResultRef: '/tmp/subagents/child.jsonl',
    }
    const completion = {
        communicationId: 'comm-1' as CommunicationId,
        runSequence: 2,
        author: '/root/child' as AgentPath,
        recipient: '/root' as AgentPath,
        payload: 'final answer',
        meta,
    }

    it('keeps taskId and runSequence through restore and V2 migration', () => {
        const snapshot = v3([agent({ pendingCompletions: [completion] })])
        assert.equal(isPersistedStateV3(snapshot), true)
        const restored = restoreAgentRecords(snapshot, 'root-session')
        assert.deepEqual(restored[0]?.pendingCompletions?.[0]?.meta, meta)
        const rewritten = serializeAgentRecords(restored, 'root-session')
        assert.deepEqual(
            rewritten.agents[0]?.pendingCompletions?.[0]?.meta,
            meta
        )

        const legacy = v2([agent({ pendingCompletions: [completion] })])
        const migrated = parsePersistedState(legacy)
        assert.deepEqual(
            migrated?.agents[0]?.pendingCompletions?.[0]?.meta,
            meta
        )
    })

    it('drops malformed correlation fields without dropping the completion', () => {
        const snapshot = v3([
            agent({
                pendingCompletions: [
                    {
                        ...completion,
                        meta: {
                            ...meta,
                            taskId: '',
                            runSequence: 1.5,
                        },
                    },
                ],
            }),
        ])
        assert.equal(isPersistedStateV3(snapshot), false)
        const parsed = parsePersistedStateV3(snapshot)
        const restoredMeta = parsed?.agents[0]?.pendingCompletions?.[0]?.meta
        assert.equal(restoredMeta?.model, meta.model)
        assert.equal(restoredMeta?.fullResultRef, meta.fullResultRef)
        assert.equal(restoredMeta?.taskId, undefined)
        assert.equal(restoredMeta?.runSequence, undefined)
    })
})

describe('archive and task serialization', () => {
    it('serializes archived agents with usage and omits the root', () => {
        const child = {
            id: 'worker-id' as AgentId,
            path: '/root/worker' as AgentPath,
            parentId: null,
            parentPath: '/root' as AgentPath,
            status: { _tag: 'Completed', message: 'done' },
            residency: 'unloaded',
            model: 'test-provider/test-model',
            activeTools: ['read'],
            createdAt: 10,
            lastActivityAt: 20,
            runSequence: 1,
            archivedAt: 30,
            usage: {
                provider: 'test-provider',
                modelId: 'test-model',
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.01,
                userMessages: 1,
                assistantMessages: 1,
                toolResults: 0,
                toolCalls: [],
            },
        } as never
        const root = {
            ...(child as Record<string, unknown>),
            id: 'root-id',
            path: '/root',
        } as never
        const snapshot = serializeAgentRecords([root, child], 'root-session', [
            task(),
        ])
        assert.equal(snapshot.version, 3)
        assert.equal(snapshot.agents.length, 1)
        assert.equal(snapshot.agents[0]?.archivedAt, 30)
        assert.deepEqual(
            snapshot.agents[0]?.usage,
            (
                child as never as {
                    usage: unknown
                }
            ).usage
        )
        assert.deepEqual(snapshot.tasks, [task()])

        const restored = restoreAgentRecords(snapshot, 'root-session')
        assert.equal(
            (restored[0] as { archivedAt?: number } | undefined)?.archivedAt,
            30
        )
        assert.deepEqual(restoreAgentTasks(snapshot, 'root-session'), [task()])
        assert.deepEqual(restoreAgentTasks(snapshot, 'other-root'), [])
        assert.deepEqual(restoreAgentTasks(snapshot, 'unknown-root'), [task()])
    })

    it('still rejects an invalid model identity', () => {
        assert.throws(
            () =>
                serializeAgentRecords(
                    [
                        {
                            id: 'bad',
                            path: '/root/bad',
                            model: 'not-a-model',
                        } as never,
                    ],
                    'root-session'
                ),
            /Invalid model identity/
        )
    })
})

describe('empty snapshots', () => {
    it('treats a canonical empty snapshot as authoritative', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v3([], [], PERSISTED_AT)
        )
        const found = findLatestState(session.getBranch())
        assert.equal(found?.version, 3)
        assert.deepEqual(found?.agents, [])
        assert.deepEqual(found?.tasks, [])
    })

    it('skips a snapshot that declared agents but recovered none', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v3([agent({ task: 'earlier' })], [], 100)
        )
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v3(
                [agent({ id: 'bad', path: 'x', model: 'broken' as never })],
                [],
                200
            )
        )
        const found = findLatestState(session.getBranch())
        assert.equal(found?.persistedAt, 100)
        assert.equal(found?.agents[0]?.task, 'earlier')
    })
})
