import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    parseCurrentBranch,
    parseSessionFile,
    loadSubagentStats,
} from './parser.ts'
import { buildStatsFromSnapshotData } from './subagent-snapshot.ts'
import { calculateAllSessionTotals } from './output.ts'
import type { SessionEntryLike } from '../shared/usage.ts'
import {
    parsePersistedState,
    isPersistedState,
} from '../subagents/src/persistence/session-state.ts'

function message(model: string, input: number, cost: number) {
    return {
        type: 'message',
        message: {
            role: 'assistant',
            provider: 'test',
            model,
            content: [{ type: 'text', text: 'Answer' }],
            usage: {
                input,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: cost },
            },
        },
    }
}

function usage(cost = 1) {
    return {
        provider: 'test',
        modelId: 'last-model',
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost,
        userMessages: 1,
        assistantMessages: 1,
        toolResults: 0,
        toolCalls: [],
    }
}

function agent(path: string, sessionFile?: string, extra = {}) {
    return {
        id: path,
        path,
        model: { provider: 'test', id: 'last-model' },
        rootSessionId: 'root',
        parentPath: path.slice(0, path.lastIndexOf('/')),
        status: 'Running',
        activeTools: [],
        createdAt: 1,
        lastActivityAt: 2,
        runSequence: 1,
        sessionFile,
        usage: usage(),
        ...extra,
    }
}

function snapshot(agents: unknown[]) {
    return { version: 2, rootSessionId: 'root', persistedAt: 10, agents }
}

function stateEntry(data: unknown) {
    return { type: 'custom', customType: 'subagents-v3-state', data }
}

function jsonl(entries: unknown[]) {
    return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

test('root billing includes each child and nested child once and refreshes an idle root cache', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'stats-tree-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'root.jsonl')
    const child = join(directory, 'child.jsonl')
    const nested = join(directory, 'nested.jsonl')
    await writeFile(
        child,
        jsonl([
            message('inherited-model', 900, 9),
            {
                type: 'custom',
                customType: 'subagents-v3-agent-meta',
                data: { path: '/root/child' },
            },
            message('child-model', 100, 3),
        ])
    )
    await writeFile(nested, jsonl([message('nested-model', 100, 5)]))
    await writeFile(
        root,
        jsonl([
            message('parent-model', 100, 2),
            stateEntry(
                snapshot([
                    agent('/root/child', child),
                    agent('/root/child/nested', nested),
                ])
            ),
        ])
    )
    const first = await parseSessionFile(root)
    assert.equal(first.totalTokens.cost.total, 10)
    assert.equal(first.assistantMessages, 3)
    assert.deepEqual(
        new Set(first.models.map((model) => model.modelId)),
        new Set(['parent-model', 'child-model', 'nested-model'])
    )
    assert.equal(first.subagents?.length, 2)
    assert.equal(first.subagents?.[0]?.file, child)
    assert.equal(calculateAllSessionTotals([first]).rootSessionCount, 1)
    assert.equal(calculateAllSessionTotals([first]).subagentRuns, 2)

    await appendFile(child, jsonl([message('second-child-model', 100, 4)]))
    const updated = await parseSessionFile(root)
    assert.equal(updated.totalTokens.cost.total, 14)
    assert.equal(updated.assistantMessages, 4)
    assert.ok(
        updated.models.some((model) => model.modelId === 'second-child-model')
    )
})

test('in-memory and unreadable children retain their reported model breakdown and summary cost', async () => {
    const models = [
        {
            provider: 'test',
            modelId: 'first',
            count: 1,
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 2,
            reportedCost: 2,
            pricedTokens: 110,
            pricingSource: 'reported',
        },
        {
            provider: 'test',
            modelId: 'second',
            count: 1,
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 3,
            catalogCost: 3,
            pricedTokens: 110,
            pricingSource: 'catalog',
        },
    ]
    const data = snapshot([
        agent('/root/child', '/nonexistent/child.jsonl', {
            usage: {
                ...usage(5.5),
                input: 250,
                output: 20,
                assistantMessages: 2,
                models,
            },
        }),
    ])
    const parsed = parsePersistedState(data)!
    assert.equal(isPersistedState(parsed), true)
    const stats = await loadSubagentStats(parsed, '/root.jsonl')
    assert.equal(stats[0]?.totalTokens.cost.total, 5.5)
    assert.equal(stats[0]?.totalTokens.cost.reported, 2.5)
    assert.equal(stats[0]?.totalTokens.cost.catalog, 3)
    assert.equal(stats[0]?.totalTokens.cost.pricedTokens, 270)
    assert.deepEqual(
        stats[0]?.models.map((model) => model.modelId),
        ['first', 'second']
    )
    assert.equal(
        buildStatsFromSnapshotData(data, '/root.jsonl')[0]?.totalTokens.cost
            .total,
        5.5
    )
})

test('current child counters exclude inherited context and keep legitimate zero-cost responses', () => {
    const stats = parseCurrentBranch(
        [
            { type: 'message', message: { role: 'user' } },
            message('inherited', 900, 9),
            {
                type: 'custom',
                customType: 'subagents-v3-agent-meta',
                data: { path: '/root/child' },
            },
            { type: 'message', message: { role: 'user' } },
            message('free-model', 100, 0),
        ],
        '/child.jsonl'
    )
    assert.equal(stats.userMessages, 1)
    assert.equal(stats.assistantMessages, 1)
    assert.equal(stats.totalTokens.totalTokens, 110)
    assert.equal(stats.totalTokens.cost.total, 0)
    assert.equal(stats.agentPath, '/root/child')
    assert.deepEqual(
        stats.models.map((model) => model.modelId),
        ['free-model']
    )
})

test('malformed latest snapshots do not erase earlier child billing', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'stats-recovery-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'root.jsonl')
    await writeFile(
        root,
        jsonl([
            message('parent', 100, 2),
            stateEntry(snapshot([agent('/root/child')])),
            stateEntry({
                version: 2,
                rootSessionId: 'root',
                agents: [{ garbage: true }],
            }),
        ])
    )
    assert.equal((await parseSessionFile(root)).totalTokens.cost.total, 3)
    await appendFile(root, jsonl([stateEntry(snapshot([]))]))
    assert.equal((await parseSessionFile(root)).totalTokens.cost.total, 2)
})

test('malformed physical-model rows are recovered without invalidating valid siblings', () => {
    const data = snapshot([
        agent('/root/child', undefined, {
            usage: {
                ...usage(),
                models: [
                    null,
                    {
                        provider: 'test',
                        modelId: 'valid',
                        count: 1,
                        input: Infinity,
                        output: 10,
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: 1,
                        pricingSource: { toString: () => 'reported' },
                    },
                ],
            },
        }),
    ])
    assert.equal(isPersistedState(data), false)
    const parsed = parsePersistedState(data)!
    assert.equal(isPersistedState(parsed), true)
    assert.equal(parsed.agents[0]?.usage?.models?.length, 1)
    assert.equal(parsed.agents[0]?.usage?.models?.[0]?.input, 0)
    assert.equal(parsed.agents[0]?.usage?.models?.[0]?.pricingSource, undefined)
})
