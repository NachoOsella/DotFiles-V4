import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentId, AgentPath, CommunicationId } from '../domain/ids.ts'
import {
    restoreAgentRecords,
    serializeAgentRecords,
} from './record-snapshot.ts'

function record(status = AgentStatus.running()): AgentRecord {
    return {
        id: 'worker-id' as AgentId,
        path: '/root/worker' as AgentPath,
        parentId: null,
        parentPath: ROOT_PATH,
        status,
        residency: 'loaded',
        model: 'test-provider/test-model',
        activeTools: ['bash'],
        sessionFile: '/tmp/worker.jsonl',
        sessionId: 'worker-session',
        createdAt: 1,
        lastActivityAt: 2,
        runSequence: 2,
        lastDeliveredRunSequence: 1,
        task: 'Review the project',
        pendingCompletions: [
            {
                communicationId: 'completion-id' as CommunicationId,
                runSequence: 2,
                author: '/root/worker' as AgentPath,
                recipient: ROOT_PATH,
                payload: 'Saved result',
            },
        ],
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
            toolCalls: [{ name: 'bash', count: 1 }],
        },
    }
}

test('record snapshots preserve resumable data and restore live runs as interrupted', () => {
    const child = record()
    const root = {
        ...child,
        id: 'root-id' as AgentId,
        path: ROOT_PATH,
        model: 'root',
    }
    const snapshot = serializeAgentRecords([root, child], 'root-session')
    const restored = restoreAgentRecords(
        JSON.parse(JSON.stringify(snapshot)),
        'root-session'
    )
    assert.equal(restored.length, 1)
    assert.equal(restored[0]?.path, child.path)
    assert.equal(restored[0]?.residency, 'unloaded')
    assert.equal(restored[0]?.status._tag, 'Interrupted')
    assert.equal(restored[0]?.sessionFile, child.sessionFile)
    assert.equal(restored[0]?.sessionId, child.sessionId)
    assert.equal(restored[0]?.task, child.task)
    assert.deepEqual(restored[0]?.usage, child.usage)
    assert.deepEqual(restored[0]?.pendingCompletions, child.pendingCompletions)
})

test('record restoration preserves terminal outcomes', () => {
    for (const status of [
        AgentStatus.completed('Done'),
        AgentStatus.errored('Provider failed'),
        AgentStatus.shutdown(),
        AgentStatus.notFound(),
    ]) {
        const snapshot = serializeAgentRecords([record(status)], 'root-session')
        assert.deepEqual(
            restoreAgentRecords(snapshot, 'root-session')[0]?.status,
            status
        )
    }
})

test('record restoration rejects unrelated roots and tolerates unusable snapshots', () => {
    const snapshot = serializeAgentRecords([record()], 'root-session')
    assert.deepEqual(restoreAgentRecords(snapshot, 'other-root'), [])
    assert.equal(restoreAgentRecords(snapshot, 'unknown-root').length, 1)
    for (const value of [
        null,
        undefined,
        { version: 3 },
        { version: 2, agents: [null] },
    ]) {
        assert.deepEqual(restoreAgentRecords(value, 'root-session'), [])
    }
})

test('record restoration rejects retired V1 snapshots', () => {
    const legacy = {
        version: 1,
        rootSessionId: 'root-session',
        agents: [
            {
                id: 'legacy-id',
                path: '/root/legacy',
                model: 'test-provider/test-model',
                statusTag: 'Completed',
                createdAt: 1,
                lastActivityAt: 2,
            },
        ],
    }
    assert.deepEqual(restoreAgentRecords(legacy, 'root-session'), [])
    assert.deepEqual(restoreAgentRecords(legacy, 'unknown-root'), [])
})
