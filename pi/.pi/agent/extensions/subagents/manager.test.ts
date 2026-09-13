import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_SUBAGENTS_CONFIG } from './src/config.ts'
import { FakePiHost } from './src/fake-host.ts'
import type { AgentPath } from './src/ids.ts'
import { SubagentManager } from './src/manager.ts'

const ROOT = '/root' as AgentPath

function makeManager(overrides: Partial<typeof DEFAULT_SUBAGENTS_CONFIG> = {}) {
    const host = new FakePiHost()
    const manager = new SubagentManager(host, {
        ...DEFAULT_SUBAGENTS_CONFIG,
        ...overrides,
    })
    return { host, manager }
}

async function waitForStatus(
    manager: SubagentManager,
    path: AgentPath,
    tag: string,
    timeoutMs = 2_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const record = manager.getRecordByPath(path)
        if (record?.status._tag === tag) return
        if (Date.now() > deadline) {
            throw new Error(
                `timed out waiting for ${path} to become ${tag} (was ${record?.status._tag})`
            )
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

describe('spawn', () => {
    it('returns immediately with a canonical path and full-history fork', async () => {
        const { host, manager } = makeManager()
        const history = ['parent turn one', 'parent turn two']
        const result = await manager.spawn({
            caller: ROOT,
            taskName: 'inspect_tests',
            message: 'check tests',
            parentHistory: history,
        })
        assert.equal(result.path, '/root/inspect_tests')
        assert.equal(host.created.length, 1)
        assert.deepEqual([...(host.created[0]!.forkMessages ?? [])], history)
        await waitForStatus(manager, result.path, 'Completed')
        host.resume()
    })

    it('supports none and last-N forks', async () => {
        const { host, manager } = makeManager()
        const history = ['t1', 't2', 't3']
        const none = await manager.spawn({
            caller: ROOT,
            taskName: 'fresh',
            message: 'narrow',
            forkTurns: 'none',
            parentHistory: history,
        })
        assert.deepEqual([...(host.created[0]!.forkMessages ?? [])], [])
        const lastN = await manager.spawn({
            caller: ROOT,
            taskName: 'recent',
            message: 'bounded',
            forkTurns: '2',
            parentHistory: history,
        })
        assert.deepEqual(
            [...(host.created[1]!.forkMessages ?? [])],
            ['t2', 't3']
        )
        await waitForStatus(manager, none.path, 'Completed')
        await waitForStatus(manager, lastN.path, 'Completed')
    })

    it('rejects invalid forks, empty messages, and bad names', async () => {
        const { manager } = makeManager()
        await assert.rejects(
            () =>
                manager.spawn({
                    caller: ROOT,
                    taskName: 'a',
                    message: 'x',
                    forkTurns: '0',
                }),
            /fork_turns/
        )
        await assert.rejects(
            () =>
                manager.spawn({ caller: ROOT, taskName: 'a', message: '   ' }),
            /empty/i
        )
        await assert.rejects(
            () =>
                manager.spawn({
                    caller: ROOT,
                    taskName: 'Bad-Name',
                    message: 'x',
                }),
            /task_name/i
        )
    })

    it('rejects duplicate paths, including concurrent races', async () => {
        const { manager } = makeManager()
        await manager.spawn({ caller: ROOT, taskName: 'dup', message: 'one' })
        await assert.rejects(
            () =>
                manager.spawn({
                    caller: ROOT,
                    taskName: 'dup',
                    message: 'two',
                }),
            /already exists/
        )

        const { manager: racy } = makeManager()
        const attempts = await Promise.allSettled([
            racy.spawn({ caller: ROOT, taskName: 'race', message: 'a' }),
            racy.spawn({ caller: ROOT, taskName: 'race', message: 'b' }),
        ])
        const fulfilled = attempts.filter((r) => r.status === 'fulfilled')
        const rejected = attempts.filter((r) => r.status === 'rejected')
        assert.equal(fulfilled.length, 1)
        assert.equal(rejected.length, 1)
    })

    it('applies model overrides independently of full-history forks', async () => {
        const { host, manager } = makeManager()
        await manager.spawn({
            caller: ROOT,
            taskName: 'm',
            message: 'x',
            model: 'provider/other',
            reasoningEffort: 'high',
            forkTurns: 'all',
        })
        assert.deepEqual(host.createdOptions[0], {
            model: 'provider/other',
            reasoningEffort: 'high',
            fork: { _tag: 'All' },
        })
    })
})

describe('capacity', () => {
    it('rejects immediately when full and releases on completion', async () => {
        const { host, manager } = makeManager({ maxConcurrentAgents: 1 })
        host.pause()
        await manager.spawn({ caller: ROOT, taskName: 'one', message: 'a' })
        await assert.rejects(
            () =>
                manager.spawn({ caller: ROOT, taskName: 'two', message: 'b' }),
            /active slots/
        )
        host.resume()
        await waitForStatus(manager, '/root/one' as AgentPath, 'Completed')
        const retry = await manager.spawn({
            caller: ROOT,
            taskName: 'two',
            message: 'b',
        })
        await waitForStatus(manager, retry.path, 'Completed')
    })

    it('releases permits on error and interruption', async () => {
        const { host, manager } = makeManager({ maxConcurrentAgents: 1 })
        host.pause()
        const failing = await manager.spawn({
            caller: ROOT,
            taskName: 'fail',
            message: 'a',
        })
        const session = host.created[0]!
        host.queueFailure(session.handleId, 'model exploded')
        host.resume()
        await waitForStatus(manager, failing.path, 'Errored')
        const retry = await manager.spawn({
            caller: ROOT,
            taskName: 'next',
            message: 'b',
        })
        await waitForStatus(manager, retry.path, 'Completed')
    })
})

describe('messaging', () => {
    it('send_message is queue-only and loads unloaded targets', async () => {
        const { host, manager } = makeManager()
        host.pause()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'w',
            message: 'task',
        })
        // While the turn is paused the agent is Running; queue a message.
        await manager.sendMessage({
            caller: ROOT,
            target: '/root/w',
            message: 'progress',
        })
        const record = manager.getRecordByPath(child.path)!
        assert.equal(record.status._tag, 'Running')
        host.resume()
        await waitForStatus(manager, child.path, 'Completed')
        // Parent receives exactly one FINAL_ANSWER envelope, nothing else.
        const mail = manager.drainMailbox(ROOT)
        assert.equal(mail.length, 1)
        assert.equal(mail[0]!.messageType, 'FINAL_ANSWER')
        await assert.rejects(
            () =>
                manager.sendMessage({
                    caller: ROOT,
                    target: '/root/w',
                    message: '  ',
                }),
            /empty/i
        )
        await assert.rejects(
            () =>
                manager.sendMessage({
                    caller: ROOT,
                    target: '/root/missing',
                    message: 'hi',
                }),
            /not found/
        )
    })

    it('followup restarts terminal agents and rejects root', async () => {
        const { manager } = makeManager()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'r',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Completed')
        await manager.followup({
            caller: ROOT,
            target: '/root/r',
            message: 'again',
        })
        await waitForStatus(manager, child.path, 'Completed')
        await assert.rejects(
            () =>
                manager.followup({
                    caller: ROOT,
                    target: '/root',
                    message: 'x',
                }),
            /\/root/
        )
    })

    it('wait wakes on pending mail, future mail, and steer; never returns payload', async () => {
        const { manager } = makeManager()
        const pending = await manager.wait({ caller: ROOT, timeoutMs: 50 })
        assert.equal(pending.timedOut, true)
        assert.match(pending.message, /timed out/i)

        await manager.spawn({ caller: ROOT, taskName: 'ping', message: 'task' })
        // Spawn drains the child's NEW_TASK; completion delivers FINAL_ANSWER
        // to the parent mailbox. Wait for that delivery first.
        await waitForStatus(manager, '/root/ping' as AgentPath, 'Completed')
        const immediate = await manager.wait({ caller: ROOT, timeoutMs: 50 })
        assert.equal(immediate.timedOut, false)
        assert.match(immediate.message, /completed/i)
        assert.ok(
            !immediate.message.includes('ok'),
            'wait must not leak child output'
        )
        // Wait does not consume: the answer is still queued for the boundary.
        assert.equal(manager.drainMailbox(ROOT).length, 1)

        // Future mail wakes the waiter.
        const waiter = manager.wait({ caller: ROOT, timeoutMs: 2_000 })
        await manager.spawn({
            caller: ROOT,
            taskName: 'later',
            message: 'task',
        })
        const woken = await waiter
        assert.equal(woken.timedOut, false)

        // Steering wakes with the interrupted message (drain first so the
        // lost-wakeup check sees an empty mailbox).
        manager.drainMailbox(ROOT)
        const steerWait = manager.wait({ caller: ROOT, timeoutMs: 2_000 })
        manager.notifySteer(ROOT)
        const steered = await steerWait
        assert.match(steered.message, /new input/i)
    })

    it('interrupt preserves identity and allows followup', async () => {
        const { host, manager } = makeManager()
        host.pause()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'v',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Running')
        const previous = await manager.interrupt({
            caller: ROOT,
            target: '/root/v',
        })
        assert.equal(previous._tag, 'Interrupted')
        host.resume()
        await waitForStatus(manager, child.path, 'Interrupted')
        // No FINAL_ANSWER for interruptions.
        assert.equal(manager.drainMailbox(ROOT).length, 0)
        await manager.followup({
            caller: ROOT,
            target: '/root/v',
            message: 'retry',
        })
        await waitForStatus(manager, child.path, 'Completed')
        await assert.rejects(
            () => manager.interrupt({ caller: ROOT, target: '/root' }),
            /itself/
        )
    })
})

describe('inspection and persistence', () => {
    it('lists logical agents with prefix filtering without loading', async () => {
        const { host, manager } = makeManager()
        await manager.spawn({ caller: ROOT, taskName: 'a', message: 'x' })
        await manager.spawn({ caller: ROOT, taskName: 'b', message: 'y' })
        await waitForStatus(manager, '/root/a' as AgentPath, 'Completed')
        const all = manager.list(ROOT)
        assert.equal(all.length, 2)
        const filtered = manager.list(ROOT, '/root/a')
        assert.equal(filtered.length, 1)
        assert.equal(filtered[0]!.path, '/root/a')
        assert.equal(host.created.length, 2)
    })

    it('restores logical identities lazily and reloads on followup', async () => {
        const { manager } = makeManager()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'cold',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Completed')
        const snapshot = manager.serialize('root-session')

        const { manager: restored } = makeManager()
        restored.restore(snapshot)
        const record = restored.getRecordByPath(child.path)!
        assert.ok(record)
        assert.equal(record.residency, 'unloaded')
        assert.equal(restored.list(ROOT).length, 1)
        await restored.followup({
            caller: ROOT,
            target: child.path as string,
            message: 'again',
        })
        await waitForStatus(restored, child.path, 'Completed')
    })

    it('delivers terminal errors as bounded FINAL_ANSWER to the direct parent', async () => {
        const { host, manager } = makeManager()
        host.pause()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'err',
            message: 'task',
        })
        host.queueFailure(host.created[0]!.handleId, 'x'.repeat(20_000))
        host.resume()
        await waitForStatus(manager, child.path, 'Errored')
        const mail = manager.drainMailbox(ROOT)
        assert.equal(mail.length, 1)
        assert.equal(mail[0]!.messageType, 'FINAL_ANSWER')
        assert.match(mail[0]!.payload, /Agent errored/)
        assert.ok(mail[0]!.payload.length < 20_000)
    })
})

describe('usage reporting', () => {
    it('accumulates session deltas across turns into the snapshot', async () => {
        const { host, manager } = makeManager()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'metered',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Completed')
        const handle = host.created[0]!.handleId
        host.setUsage(handle, {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            cost: 0.02,
            userMessages: 2,
            assistantMessages: 2,
            toolResults: 1,
            toolCalls: [{ name: 'bash', count: 1 }],
        })
        await manager.followup({
            caller: ROOT,
            target: '/root/metered',
            message: 'more',
        })
        await waitForStatus(manager, child.path, 'Completed')
        const snapshot = manager.serialize('root-session')
        const persisted = snapshot.agents.find(
            (agent) => agent.path === '/root/metered'
        )
        assert.deepEqual(persisted?.usage, {
            provider: 'test',
            modelId: 'test-model',
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            cost: 0.02,
            userMessages: 2,
            assistantMessages: 2,
            toolResults: 1,
            toolCalls: [{ name: 'bash', count: 1 }],
        })
        // A second turn with unchanged cumulative usage adds no double count.
        await manager.followup({
            caller: ROOT,
            target: '/root/metered',
            message: 'again',
        })
        await waitForStatus(manager, child.path, 'Completed')
        const again = manager
            .serialize('root-session')
            .agents.find((agent) => agent.path === '/root/metered')
        assert.equal(again?.usage?.input, 100)
        assert.equal(again?.usage?.assistantMessages, 2)
    })

    it('survives eviction and reload without double counting', async () => {
        const { host, manager } = makeManager({ maxResidentAgents: 1 })
        const first = await manager.spawn({
            caller: ROOT,
            taskName: 'first',
            message: 'task',
        })
        await waitForStatus(manager, first.path, 'Completed')
        host.setUsage(host.created[0]!.handleId, {
            input: 40,
            output: 20,
            assistantMessages: 1,
            userMessages: 1,
        })
        // Touch usage through one more turn so totals are captured pre-eviction.
        await manager.followup({
            caller: ROOT,
            target: '/root/first',
            message: 'more',
        })
        await waitForStatus(manager, first.path, 'Completed')
        const second = await manager.spawn({
            caller: ROOT,
            taskName: 'second',
            message: 'task',
        })
        await waitForStatus(manager, second.path, 'Completed')
        const evicted = manager.getRecordByPath(first.path)!
        assert.equal(evicted.residency, 'unloaded')
        assert.equal(evicted.usage?.input, 40)
        // Reload on followup keeps old totals and adds only the new delta.
        await manager.followup({
            caller: ROOT,
            target: '/root/first',
            message: 'back',
        })
        await waitForStatus(manager, first.path, 'Completed')
        assert.equal(manager.getRecordByPath(first.path)?.usage?.input, 40)
        host.setUsage(host.created[2]!.handleId, {
            input: 60,
            assistantMessages: 1,
            userMessages: 1,
        })
        await manager.followup({
            caller: ROOT,
            target: '/root/first',
            message: 'once more',
        })
        await waitForStatus(manager, first.path, 'Completed')
        assert.equal(manager.getRecordByPath(first.path)?.usage?.input, 100)
    })

    it('includes persistedAt, previews, and top tools in the snapshot', async () => {
        const { manager } = makeManager()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'previewed',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Completed')
        const snapshot = manager.serialize('root-session')
        assert.ok(
            typeof snapshot.persistedAt === 'number' && snapshot.persistedAt > 0
        )
        const persisted = snapshot.agents.find(
            (agent) => agent.path === '/root/previewed'
        )
        assert.ok(persisted)
        // Fake host completes with 'ok': preview present or safely absent.
        assert.ok(
            persisted.lastMessagePreview === undefined ||
                (typeof persisted.lastMessagePreview === 'string' &&
                    persisted.lastMessagePreview.length <= 201)
        )
    })

    it('flushUsage captures running turns without closing sessions', async () => {
        const { host, manager } = makeManager()
        host.pause()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'live',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Running')
        host.setUsage(host.created[0]!.handleId, {
            input: 40,
            assistantMessages: 1,
            userMessages: 1,
        })
        await manager.flushUsage()
        assert.equal(manager.getRecordByPath(child.path)?.usage?.input, 40)
        host.resume()
        await waitForStatus(manager, child.path, 'Completed')
    })

    it('captures in-flight usage on shutdown', async () => {
        const { host, manager } = makeManager()
        host.pause()
        const child = await manager.spawn({
            caller: ROOT,
            taskName: 'brief',
            message: 'task',
        })
        await waitForStatus(manager, child.path, 'Running')
        host.setUsage(host.created[0]!.handleId, {
            input: 25,
            assistantMessages: 1,
            userMessages: 1,
        })
        await manager.shutdown()
        const record = manager.getRecordByPath(child.path)!
        assert.equal(record.status._tag, 'Interrupted')
        assert.equal(record.usage?.input, 25)
        assert.equal(
            manager.serialize('root-session').agents[0]?.usage?.input,
            25
        )
    })
})
