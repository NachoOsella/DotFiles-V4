import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseSessionFile } from './parser.ts'
import {
    buildStatsFromSnapshotData,
    buildSubagentSnapshotStats,
    getSubagentSnapshotAge,
} from './subagent-snapshot.ts'
import type { ModelPricingResolver } from './types.ts'

const FILE = '/tmp/parent.jsonl'

function snapshotEntry(agents: unknown[]) {
    return {
        type: 'custom',
        customType: 'subagents-v2-state',
        data: {
            version: 1,
            rootSessionId: 'root-1',
            agents,
        },
    }
}

function agent(path: string, usage: unknown, extra: unknown = {}) {
    return {
        id: `id-${path}`,
        path,
        parentId: null,
        model: 'openai-codex/gpt-5.6-luna',
        statusTag: 'Completed',
        createdAt: 1_000,
        lastActivityAt: 5_000,
        usage,
        ...(extra as Record<string, unknown>),
    }
}

function usage(overrides: Record<string, unknown> = {}) {
    return {
        provider: 'openai-codex',
        modelId: 'gpt-5.6-luna',
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.02,
        userMessages: 2,
        assistantMessages: 2,
        toolResults: 1,
        toolCalls: [{ name: 'bash', count: 2 }],
        ...overrides,
    }
}

test('maps snapshot agents to stats with reported cost', () => {
    const entries = [
        { type: 'message', message: { role: 'user' } },
        snapshotEntry([agent('/root/worker', usage())]),
    ]
    const stats = buildSubagentSnapshotStats(entries, FILE)
    assert.equal(stats.length, 1)
    const worker = stats[0]!
    assert.equal(worker.name, '/root/worker')
    assert.equal(worker.parentSessionPath, FILE)
    assert.equal(worker.assistantMessages, 2)
    assert.equal(worker.userMessages, 2)
    assert.equal(worker.toolResults, 1)
    assert.deepEqual(worker.toolCalls, [{ name: 'bash', count: 2 }])
    assert.equal(worker.totalTokens.totalTokens, 150)
    assert.equal(worker.totalTokens.cost.total, 0.02)
    assert.equal(worker.totalTokens.cost.reported, 0.02)
    assert.equal(worker.models[0]?.modelId, 'gpt-5.6-luna')
    assert.equal(worker.models[0]?.count, 2)
    assert.equal(worker.models[0]?.pricingSource, 'reported')
    assert.equal(worker.durationMs, 4_000)
})

test('falls back to catalog pricing when no reported cost exists', () => {
    const pricing: ModelPricingResolver = () => ({
        input: 1,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        source: 'catalog',
    })
    const stats = buildStatsFromSnapshotData(
        {
            version: 1,
            rootSessionId: 'root-1',
            agents: [agent('/root/a', usage({ cost: 0 }))],
        },
        FILE,
        pricing
    )
    assert.equal(stats[0]?.totalTokens.cost.catalog, (100 * 1 + 50 * 4) / 1e6)
    assert.equal(stats[0]?.totalTokens.cost.reported, 0)
    assert.equal(stats[0]?.models[0]?.pricingSource, 'catalog')
})

test('marks unknown pricing when nothing resolves', () => {
    const stats = buildStatsFromSnapshotData(
        {
            version: 1,
            rootSessionId: 'root-1',
            agents: [agent('/root/a', usage({ cost: 0 }))],
        },
        FILE
    )
    assert.equal(stats[0]?.totalTokens.cost.unknownTokens, 150)
    assert.equal(stats[0]?.models[0]?.pricingSource, 'unknown')
})

test('latest snapshot wins and empty agents are skipped', () => {
    const entries = [
        snapshotEntry([agent('/root/old', usage({ input: 10, output: 5 }))]),
        { type: 'message', message: { role: 'user' } },
        snapshotEntry([
            agent('/root/old', usage({ input: 30, output: 5 })),
            agent('/root/fresh', undefined),
            agent(
                '/root/zero',
                usage({
                    input: 0,
                    output: 0,
                    cost: 0,
                    userMessages: 0,
                    assistantMessages: 0,
                    toolResults: 0,
                    toolCalls: [],
                })
            ),
            'garbage',
            42,
        ]),
    ]
    const stats = buildSubagentSnapshotStats(entries, FILE)
    assert.equal(stats.length, 1)
    assert.equal(stats[0]?.name, '/root/old')
    assert.equal(stats[0]?.totalTokens.input, 30)
})

test('tolerates malformed snapshots', () => {
    assert.deepEqual(buildStatsFromSnapshotData(undefined, FILE), [])
    assert.deepEqual(buildStatsFromSnapshotData({ version: 2 }, FILE), [])
    assert.deepEqual(
        buildStatsFromSnapshotData(
            { version: 1, rootSessionId: 'x', agents: 'nope' },
            FILE
        ),
        []
    )
    assert.deepEqual(buildSubagentSnapshotStats([], FILE), [])
})

test('parser folds snapshot usage into persisted file totals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stats-snapshot-'))
    try {
        const file = join(dir, 'parent.jsonl')
        const lines = [
            JSON.stringify({
                type: 'session',
                id: 'root-1',
                timestamp: '2026-01-01T00:00:00.000Z',
                cwd: '/repo',
            }),
            JSON.stringify({
                type: 'message',
                timestamp: '2026-01-01T00:00:01.000Z',
                message: {
                    role: 'assistant',
                    provider: 'openai-codex',
                    model: 'gpt-5.6-luna',
                    usage: { input: 10, output: 5, cost: { total: 0.001 } },
                    content: [],
                },
            }),
            JSON.stringify({
                type: 'custom',
                id: 'snap-1',
                parentId: null,
                timestamp: '2026-01-01T00:00:02.000Z',
                customType: 'subagents-v2-state',
                data: {
                    version: 1,
                    rootSessionId: 'root-1',
                    agents: [agent('/root/worker', usage())],
                },
            }),
        ]
        await writeFile(file, lines.join('\n') + '\n')
        const stats = await parseSessionFile(file)
        // 15 main-thread tokens + 150 subagent tokens.
        assert.equal(stats.totalTokens.totalTokens, 165)
        assert.equal(stats.totalTokens.cost.reported, 0.021)
        const modelIds = stats.models.map((model) => model.modelId)
        assert.ok(modelIds.includes('gpt-5.6-luna'))
        const worker = stats.models.find(
            (model) => model.provider === 'openai-codex'
        )
        assert.equal(worker?.input, 110)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('running and nested agents with usage are included', () => {
    const entries = [
        snapshotEntry([
            agent('/root/worker', usage(), { statusTag: 'Running' }),
            agent('/root/worker/nested', usage({ input: 20, output: 10 }), {
                statusTag: 'Running',
            }),
        ]),
    ]
    const stats = buildSubagentSnapshotStats(entries, FILE)
    assert.equal(stats.length, 2)
    assert.ok(stats.some((s) => s.name === '/root/worker'))
    assert.ok(stats.some((s) => s.name === '/root/worker/nested'))
})

test('snapshot age is undefined without persistedAt and live when fresh', () => {
    assert.equal(
        getSubagentSnapshotAge([snapshotEntry([agent('/root/a', usage())])]),
        undefined
    )
    const fresh = [
        {
            type: 'custom',
            customType: 'subagents-v2-state',
            data: {
                version: 1,
                rootSessionId: 'root-1',
                persistedAt: Date.now(),
                agents: [agent('/root/a', usage())],
            },
        },
    ]
    const age = getSubagentSnapshotAge(fresh)
    assert.ok(age !== undefined && age < 2000)
})
