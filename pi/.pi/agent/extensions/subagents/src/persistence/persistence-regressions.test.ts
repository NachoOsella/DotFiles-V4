import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import {
    findLatestState,
    isPersistedState,
    parsePersistedState,
    snapshotAge,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from './session-state.ts'
import {
    isPersistedStateV2,
    parsePersistedStateV2,
    type PersistedSubagentStateV2,
} from './schema.ts'
import {
    restoreAgentRecords,
    serializeAgentRecords,
} from './record-snapshot.ts'

const PERSISTED_AT = 1_700_000_000_000

function agent(
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        id: 'agent-a',
        path: '/root/a',
        parentPath: '/root',
        rootSessionId: 'root-session',
        model: { provider: 'test-provider', id: 'test-model' },
        activeTools: ['spawn_agent', 'send_message'],
        status: 'Completed',
        createdAt: PERSISTED_AT,
        lastActivityAt: PERSISTED_AT + 1_000,
        runSequence: 2,
        ...overrides,
    }
}

function v2(agents: readonly unknown[], persistedAt: unknown = PERSISTED_AT) {
    return {
        version: 2,
        rootSessionId: 'root-session',
        persistedAt,
        agents,
    }
}

function parseV2(value: unknown): PersistedSubagentStateV2 {
    const parsed = parsePersistedStateV2(value)
    assert.ok(parsed, 'expected a usable V2 snapshot')
    return parsed
}

function representativeSnapshot(): PersistedSubagentStateV2 {
    return {
        version: 2,
        rootSessionId: 'root-session',
        persistedAt: PERSISTED_AT,
        agents: [
            {
                id: 'agent-a',
                path: '/root/a',
                parentPath: '/root',
                rootSessionId: 'root-session',
                sessionId: 'session-a',
                sessionFile: '/tmp/subagents/a.jsonl',
                cwd: '/repo',
                role: 'default',
                model: { provider: 'test-provider', id: 'test-model' },
                thinkingLevel: 'medium',
                activeTools: ['spawn_agent', 'send_message'],
                status: 'Completed',
                statusMessage: 'done',
                createdAt: PERSISTED_AT,
                lastActivityAt: PERSISTED_AT + 1_000,
                runSequence: 2,
                lastDeliveredRunSequence: 2,
                pendingCompletions: [],
                lastResult: 'finished',
                task: 'Do the thing.',
                usage: {
                    provider: 'test-provider',
                    modelId: 'test-model',
                    input: 10,
                    output: 20,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0.01,
                    userMessages: 1,
                    assistantMessages: 2,
                    toolResults: 3,
                    toolCalls: [{ name: 'read', count: 4 }],
                },
            },
        ],
    }
}

describe('persisted snapshot roundtrip', () => {
    it('keeps a representative current snapshot unchanged', () => {
        const snapshot = representativeSnapshot()
        assert.equal(isPersistedState(snapshot), true)
        assert.equal(isPersistedStateV2(snapshot), true)
        assert.deepEqual(parsePersistedState(snapshot), snapshot)
        assert.deepEqual(parsePersistedStateV2(snapshot), snapshot)
    })

    it('finds and returns the snapshot from a session branch', () => {
        const snapshot = representativeSnapshot()
        const session = SessionManager.inMemory('/repo')
        assert.equal(findLatestState(session.getBranch()), undefined)

        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, snapshot)
        session.appendCustomEntry('unrelated', { nope: true })
        const found = findLatestState(session.getBranch())
        assert.deepEqual(found, snapshot)
        assert.equal(snapshotAge(found!), PERSISTED_AT)
    })
})

describe('malformed V2 records recover per record', () => {
    it('drops only records whose identity cannot be recovered', () => {
        const parsed = parseV2(
            v2([
                agent(),
                agent({ id: 'agent-b', path: '/root/b', model: {} }),
                agent({ id: 'agent-c', path: 'not-a-path' }),
                agent({ id: '/root', path: '/root' }),
                agent({ path: '/root/no-id', id: '' }),
            ])
        )
        assert.deepEqual(
            parsed.agents.map((entry) => entry.path),
            ['/root/a']
        )
    })

    it('deduplicates repeated ids and paths, first record wins', () => {
        const parsed = parseV2(
            v2([
                agent({ task: 'first' }),
                agent({ id: 'agent-a2', task: 'duplicate path' }),
                agent({ path: '/root/other', task: 'duplicate id' }),
            ])
        )
        assert.equal(parsed.agents.length, 1)
        assert.equal(parsed.agents[0]?.task, 'first')
    })

    it('coerces nonfinite timestamps and usage instead of dropping', () => {
        const parsed = parseV2(
            v2(
                [
                    agent({
                        id: 'agent-e',
                        path: '/root/e',
                        createdAt: Number.NaN,
                        lastActivityAt: Number.POSITIVE_INFINITY,
                    }),
                    agent({
                        id: 'agent-f',
                        path: '/root/f',
                        usage: {
                            provider: 'p',
                            modelId: 'm',
                            input: Number.POSITIVE_INFINITY,
                            output: Number.NaN,
                            cacheRead: 5,
                            cacheWrite: -1,
                            cost: 0,
                            userMessages: 0,
                            assistantMessages: 0,
                            toolResults: 0,
                            toolCalls: [
                                { name: 'read', count: 2 },
                                { name: '', count: 1 },
                                { count: 3 },
                            ],
                        },
                    }),
                ],
                777
            )
        )
        const e = parsed.agents.find((entry) => entry.id === 'agent-e')
        assert.equal(e?.createdAt, 777)
        assert.equal(e?.lastActivityAt, 777)
        const f = parsed.agents.find((entry) => entry.id === 'agent-f')
        assert.equal(f?.usage?.input, 0)
        assert.equal(f?.usage?.output, 0)
        assert.equal(f?.usage?.cacheRead, 5)
        assert.equal(f?.usage?.cacheWrite, 0)
        assert.deepEqual(f?.usage?.toolCalls, [{ name: 'read', count: 2 }])
    })

    it('omits malformed usage and normalizes recoverable scalar fields', () => {
        const parsed = parseV2(
            v2([
                agent({
                    id: 'agent-g',
                    path: '/root/g',
                    usage: { provider: 1, modelId: 'm' },
                }),
                agent({
                    id: 'agent-h',
                    path: '/root/h',
                    thinkingLevel: 'maximum',
                    status: 'Sleeping',
                    activeTools: ['bash', 7, null, 'read'],
                    lastDeliveredRunSequence: Number.NaN,
                }),
            ])
        )
        const g = parsed.agents.find((entry) => entry.id === 'agent-g')
        assert.equal(g?.usage, undefined)
        const h = parsed.agents.find((entry) => entry.id === 'agent-h')
        assert.equal(h?.thinkingLevel, undefined)
        assert.equal(h?.status, 'PendingInit')
        assert.deepEqual(h?.activeTools, ['bash', 'read'])
        assert.equal(h?.lastDeliveredRunSequence, 0)
    })

    it('falls back to the snapshot root session id for a missing one', () => {
        const parsed = parseV2(v2([agent({ rootSessionId: undefined })]))
        assert.equal(parsed.agents[0]?.rootSessionId, 'root-session')
    })

    it('treats missing usage toolCalls as a repair and normalizes to []', () => {
        const snapshot = v2([
            agent({
                usage: {
                    provider: 'p',
                    modelId: 'm',
                    input: 1,
                    output: 2,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0,
                    userMessages: 1,
                    assistantMessages: 1,
                    toolResults: 0,
                },
            }),
        ])
        assert.equal(isPersistedStateV2(snapshot), false)
        assert.deepEqual(parseV2(snapshot).agents[0]?.usage?.toolCalls, [])
    })

    it('drops a record bound to a different root session', () => {
        const parsed = parseV2(
            v2([
                agent({ task: 'kept' }),
                agent({
                    id: 'agent-foreign',
                    path: '/root/foreign',
                    rootSessionId: 'other-session',
                }),
            ])
        )
        assert.deepEqual(
            parsed.agents.map((entry) => entry.id),
            ['agent-a']
        )
        assert.equal(
            isPersistedStateV2(
                v2([
                    agent({
                        id: 'agent-foreign',
                        path: '/root/foreign',
                        rootSessionId: 'other-session',
                    }),
                ])
            ),
            false
        )
    })

    it('rejects a snapshot envelope that is not usable', () => {
        assert.equal(parsePersistedStateV2(null), undefined)
        assert.equal(
            parsePersistedStateV2({ version: 3, agents: [] }),
            undefined
        )
        assert.equal(
            parsePersistedStateV2({ version: 2, rootSessionId: 'x' }),
            undefined
        )
        assert.equal(
            parsePersistedStateV2({
                version: 2,
                rootSessionId: 'x',
                agents: {},
            }),
            undefined
        )
    })

    it('coerces a nonfinite persistedAt to zero', () => {
        const parsed = parseV2(v2([agent()], Number.NaN))
        assert.equal(parsed.persistedAt, 0)
        assert.equal(snapshotAge(parsed), 0)
    })
})

describe('pending completion envelopes', () => {
    const completion = {
        communicationId: 'comm-1',
        runSequence: 2,
        author: '/root/a',
        recipient: '/root',
        payload: 'final answer',
        meta: {
            role: 'default',
            model: 'test-provider/test-model',
            durationMs: 5,
            tokens: 3,
            cost: 0.1,
            failed: false,
        },
    }

    it('keeps only well-formed, unacknowledged completions for the owner', () => {
        const parsed = parseV2(
            v2([
                agent({
                    lastDeliveredRunSequence: 1,
                    pendingCompletions: [
                        completion,
                        { ...completion, communicationId: '' },
                        { ...completion, author: '/root/b' },
                        { ...completion, recipient: '/root/other' },
                        { ...completion, runSequence: 1 },
                        { ...completion, communicationId: 'comm-1' },
                        {
                            ...completion,
                            communicationId: 'comm-3',
                            runSequence: 3,
                            meta: { model: 7 },
                        },
                    ],
                }),
            ])
        )
        const pending = parsed.agents[0]?.pendingCompletions
        assert.deepEqual(
            pending?.map((entry) => entry.communicationId),
            ['comm-1', 'comm-3']
        )
        assert.deepEqual(pending?.[0]?.meta, completion.meta)
        assert.equal(pending?.[1]?.meta, undefined)
    })

    it('keeps a root-bound completion and clamps a corrupt run sequence', () => {
        const parsed = parseV2(
            v2([
                agent({
                    path: '/root/seq',
                    pendingCompletions: [
                        {
                            ...completion,
                            author: '/root/seq',
                            runSequence: Number.NaN,
                        },
                    ],
                }),
            ])
        )
        const pending = parsed.agents[0]?.pendingCompletions
        assert.equal(pending?.length, 1)
        assert.equal(pending?.[0]?.runSequence, 0)
        assert.equal(pending?.[0]?.recipient, '/root')
    })

    it('keeps a non-root recipient when it matches the parent path', () => {
        const parsed = parseV2(
            v2([
                agent({
                    path: '/root/parent/worker',
                    parentPath: '/root/parent',
                    pendingCompletions: [
                        {
                            ...completion,
                            author: '/root/parent/worker',
                            recipient: '/root/parent',
                        },
                    ],
                }),
            ])
        )
        assert.equal(
            parsed.agents[0]?.pendingCompletions?.[0]?.recipient,
            '/root/parent'
        )
    })
})

describe('strict guards stay honest', () => {
    it('is false when the parser had to repair the snapshot', () => {
        const repaired = v2([agent({ activeTools: ['bash', 7] })])
        assert.equal(isPersistedStateV2(repaired), false)
        assert.equal(isPersistedState(repaired), false)
        assert.deepEqual(parseV2(repaired).agents[0]?.activeTools, ['bash'])

        const missingTimestamp = v2([agent({ createdAt: undefined })])
        assert.equal(isPersistedStateV2(missingTimestamp), false)
        assert.equal(
            parseV2(missingTimestamp).agents[0]?.createdAt,
            PERSISTED_AT
        )
    })

    it('is true for a canonical empty snapshot', () => {
        const empty = v2([], PERSISTED_AT)
        assert.equal(isPersistedStateV2(empty), true)
        assert.deepEqual(parsePersistedState(empty), empty)
    })

    it('rejects values that are not snapshots', () => {
        for (const value of [null, 42, 'snapshot', [], { version: 2 }]) {
            assert.equal(isPersistedState(value), false)
            assert.equal(parsePersistedState(value), undefined)
        }
    })
})

describe('retired schemas are ignored', () => {
    it('does not migrate V1 payloads or the retired custom type', () => {
        const legacy = {
            version: 1,
            rootSessionId: 'root-session',
            persistedAt: 1234,
            agents: [{ id: 'legacy-a', path: '/root/legacy', model: 'p/m' }],
        }
        assert.equal(parsePersistedState(legacy), undefined)
        assert.equal(isPersistedState(legacy), false)

        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry('subagents-v2-state', legacy)
        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, legacy)
        assert.equal(findLatestState(session.getBranch()), undefined)
    })
})

describe('parse to restore to serialize safety', () => {
    it('never serializes a record with an invalid model', () => {
        const records = restoreAgentRecords(
            v2([
                agent({ task: 'kept' }),
                agent({
                    id: 'broken',
                    path: '/root/broken',
                    model: { provider: '', id: '' },
                }),
            ]),
            'root-session'
        )
        assert.deepEqual(
            records.map((record) => record.id),
            ['agent-a']
        )
        const serialized = serializeAgentRecords(records, 'root-session')
        assert.equal(serialized.agents.length, 1)
        assert.equal(isPersistedStateV2(serialized), true)
    })

    it('drops foreign-root records through restore and serialize', () => {
        const records = restoreAgentRecords(
            v2([
                agent({ task: 'kept' }),
                agent({
                    id: 'agent-foreign',
                    path: '/root/foreign',
                    rootSessionId: 'other-session',
                }),
            ]),
            'root-session'
        )
        assert.deepEqual(
            records.map((record) => record.id),
            ['agent-a']
        )
        const serialized = serializeAgentRecords(records, 'root-session')
        assert.deepEqual(
            serialized.agents.map((entry) => entry.rootSessionId),
            ['root-session']
        )
    })
})

describe('findLatestState recovery policy', () => {
    it('skips a snapshot that declared agents but recovered none', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2([agent({ task: 'earlier' })], 100)
        )
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2([agent({ model: {} })], 200)
        )
        const found = findLatestState(session.getBranch())
        assert.equal(found?.persistedAt, 100)
    })

    it('keeps a partially valid latest snapshot', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2([agent({ task: 'earlier' })], 100)
        )
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2(
                [agent({ task: 'latest' }), agent({ id: 'bad', path: 'x' })],
                200
            )
        )
        const found = findLatestState(session.getBranch())
        assert.equal(found?.persistedAt, 200)
        assert.equal(found?.version === 2 ? found.agents.length : -1, 1)
        assert.equal(
            found?.version === 2 ? found.agents[0]?.task : undefined,
            'latest'
        )
    })

    it('prefers a legitimate empty newer snapshot over an older one', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2([agent()], 100)
        )
        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, v2([], 200))
        const found = findLatestState(session.getBranch())
        assert.equal(found?.persistedAt, 200)
        assert.equal(found?.agents.length, 0)
    })

    it('falls back past an unusable envelope', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry(
            SUBAGENTS_STATE_CUSTOM_TYPE,
            v2([agent()], 100)
        )
        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, { version: 3 })
        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, {
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: 300,
            agents: 'nope',
        })
        assert.equal(findLatestState(session.getBranch())?.persistedAt, 100)
    })

    it('ignores unrelated custom entries', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendCustomEntry('other-state', v2([agent()], 100))
        assert.equal(findLatestState(session.getBranch()), undefined)
    })
})
