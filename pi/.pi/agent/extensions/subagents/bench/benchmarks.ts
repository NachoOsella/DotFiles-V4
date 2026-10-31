/**
 * Repeatable measurement harness for M2. It prints numbers; it does not assert
 * thresholds, because there is no pre-optimization baseline to compare against
 * and CI machines vary. Run manually before changing snapshot accounting:
 *
 *   node --experimental-strip-types extensions/subagents/bench/benchmarks.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionUsage } from '../../shared/usage.ts'
import { DEFAULT_SUBAGENTS_CONFIG } from '../src/config/config.ts'
import type { AgentRecord } from '../src/domain/agent-record.ts'
import { AgentStatus } from '../src/domain/agent-status.ts'
import type { AgentPath } from '../src/domain/ids.ts'
import { SessionFactory } from '../src/core/session-factory.ts'
import { serializeAgentRecords } from '../src/persistence/record-snapshot.ts'
import { parsePersistedStateV2 } from '../src/persistence/schema.ts'

const RESULT_CHARS = 20_000

function longResult(): string {
    return 'x'.repeat(RESULT_CHARS)
}

function record(index: number): AgentRecord {
    const path = `/root/agent_${index}` as AgentPath
    return {
        id: `agent-${index}` as AgentRecord['id'],
        path,
        parentId: 'root' as AgentRecord['id'],
        parentPath: '/root' as AgentPath,
        status: AgentStatus.completed(longResult()),
        residency: 'unloaded',
        role: 'default',
        model: 'test-provider/test-model',
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_000_000,
        activeTools: ['read', 'bash', 'edit'],
        runSequence: 3,
        lastDeliveredRunSequence: 2,
        lastResult: longResult(),
        usage: {
            provider: 'test-provider',
            modelId: 'test-model',
            input: 10_000,
            output: 2_000,
            cacheRead: 4_000,
            cacheWrite: 500,
            cost: 0.42,
            userMessages: 3,
            assistantMessages: 3,
            toolResults: 7,
            toolCalls: [{ name: 'bash', count: 7 }],
        },
    }
}

function bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function time(
    label: string,
    fn: () => Promise<unknown> | unknown
): Promise<number> {
    const start = process.hrtime.bigint()
    return Promise.resolve(fn()).then(() => {
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6
        console.log(`${label}: ${elapsed.toFixed(1)} ms`)
        return elapsed
    })
}

function snapshotBenchmark(): void {
    for (const count of [1, 6, 20]) {
        const records = Array.from({ length: count }, (_, index) =>
            record(index)
        )
        const state = serializeAgentRecords(records, 'root-session')
        const size = bytes(state)
        const parsed = parsePersistedStateV2(state)
        console.log(
            `snapshot ${count} agents x ${RESULT_CHARS} chars: ${size} bytes, parses to ${parsed?.agents.length ?? 0} records`
        )
    }
    const single = serializeAgentRecords([record(0)], 'root-session')
    console.log(
        `single long result appears ${occurrences(JSON.stringify(single), longResult())} times in one snapshot`
    )
}

function occurrences(haystack: string, needle: string): number {
    let count = 0
    let index = haystack.indexOf(needle)
    while (index !== -1) {
        count += 1
        index = haystack.indexOf(needle, index + needle.length)
    }
    return count
}

function usageBenchmark(): void {
    for (const turns of [50, 500, 2_000]) {
        const entries = []
        for (let index = 0; index < turns; index += 1) {
            entries.push({
                type: 'message',
                timestamp: 1_700_000_000_000 + index,
                message: {
                    role: 'user',
                    content: [{ type: 'text', text: `prompt ${index}` }],
                    timestamp: 1_700_000_000_000 + index,
                },
            })
            entries.push({
                type: 'message',
                timestamp: 1_700_000_000_000 + index,
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: `answer ${index}` }],
                    api: 'test-api',
                    provider: 'test-provider',
                    model: 'test-model',
                    usage: {
                        input: 100,
                        output: 50,
                        cacheRead: 10,
                        cacheWrite: 0,
                        totalTokens: 150,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: 'stop',
                    timestamp: 1_700_000_000_000 + index,
                },
            })
        }
        const start = process.hrtime.bigint()
        const stats = parseSessionUsage(entries, 'bench.jsonl')
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6
        console.log(
            `usage parse ${turns} turns: ${elapsed.toFixed(1)} ms, ${stats.totalTokens.totalTokens} tokens, ${stats.assistantMessages} assistant messages`
        )
    }
}

async function sessionBenchmark(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'subagents-bench-'))
    const factory = new SessionFactory({
        rootSessionId: () => 'bench-root',
        rootSessionDir: () => root,
        agentDir: join(root, 'agent'),
        getModelRegistry: () =>
            ({
                find: () => ({
                    id: 'test-model',
                    name: 'Bench model',
                    api: 'test-api',
                    provider: 'test-provider',
                    baseUrl: 'http://test.invalid',
                    reasoning: false,
                    input: ['text'],
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    contextWindow: 100_000,
                    maxTokens: 1_000,
                }),
            }) as never,
        buildTools: () => [],
        config: { ...DEFAULT_SUBAGENTS_CONFIG, maxDepth: 1 },
    })
    try {
        const parent = {
            path: '/root' as AgentPath,
            cwd: root,
            model: { provider: 'test-provider', id: 'test-model' },
            thinkingLevel: 'medium' as const,
            activeTools: [],
            contextEntries: [],
            sessionId: 'bench-root',
        }
        const first: AgentRecord = {
            id: 'bench-1' as AgentRecord['id'],
            path: '/root/bench_1' as AgentPath,
            parentId: 'bench-root' as AgentRecord['id'],
            parentPath: '/root' as AgentPath,
            status: AgentStatus.pendingInit(),
            residency: 'loading',
            model: 'test-provider/test-model',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            activeTools: [],
        }
        let savedSessionFile: string | undefined
        let savedSessionId: string | undefined
        await time('spawn (create + bind extensions)', async () => {
            const runtime = await factory.create(first, parent, {
                _tag: 'None',
            })
            savedSessionFile = runtime.session.sessionFile
            savedSessionId = runtime.session.sessionManager.getSessionId()
            // A child always receives a task message before it goes idle; an
            // empty session may not be flushed to disk yet.
            runtime.session.sessionManager.appendMessage({
                role: 'user',
                content: 'benchmark task',
                timestamp: Date.now(),
            })
            await runtime.dispose()
        })
        if (!savedSessionFile || !savedSessionId) {
            throw new Error('spawn produced no session file')
        }
        await time('reopen (cold SessionManager.open)', async () => {
            const runtime = await factory.open({
                ...first,
                sessionId: savedSessionId,
                sessionFile: savedSessionFile,
            })
            await runtime.dispose()
        })
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

console.log(`subagent harness benchmark (${RESULT_CHARS}-char results)\n`)
snapshotBenchmark()
console.log('')
usageBenchmark()
console.log('')
await sessionBenchmark()
