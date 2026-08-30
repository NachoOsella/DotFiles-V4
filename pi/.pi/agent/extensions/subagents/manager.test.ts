/**
 * End-to-end smoke tests for manager behavior through a real ManagedRuntime.
 * The registry uses a scripted Pi backend so lifecycle tests do not require
 * provider credentials or make network calls.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { BackendRegistry, type SubagentBackend } from './src/backend.ts'
import { makeStubBackend } from './src/backends/stub.ts'
import type { BackendName, ParentContext, SpawnTask } from './src/domain.ts'
import {
    MAX_SPAWN_PROMPT_BYTES,
    SubagentManager,
    SubagentManagerLive,
    type SubagentManagerShape,
} from './src/manager.ts'
import { runTool } from './src/runtime.ts'

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
    const piBackend = makeStubBackend({
        backend: 'pi',
        defaultModelLabel: 'pi/test-model',
        contextWindow: 128_000,
        toolName: 'bash',
        cadenceMs: 30,
    })
    return new Map<BackendName, SubagentBackend>([[piBackend.name, piBackend]])
})

const createTestRuntime = () =>
    ManagedRuntime.make(
        SubagentManagerLive.pipe(Layer.provide(TestRegistryLive))
    )

const parent: ParentContext = {
    parentCwd: process.cwd(),
    projectTrusted: false,
}

function task(
    prompt: string,
    overrides: Partial<Pick<SpawnTask, 'taskName' | 'role' | 'title'>> = {}
): SpawnTask {
    return {
        prompt,
        title: 'test',
        taskName: prompt,
        role: 'default',
        cwd: process.cwd(),
        parent,
        ...overrides,
    }
}

async function withManager(
    run: (
        manager: SubagentManagerShape,
        runtime: ReturnType<typeof createTestRuntime>
    ) => Promise<void>
) {
    const runtime = createTestRuntime()
    try {
        const manager = await runtime.runPromise(SubagentManager)
        await run(manager, runtime)
    } finally {
        await runtime.dispose()
    }
}

test('Pi subagent completes and delivers a final result', async () => {
    await withManager(async (manager, runtime) => {
        const settled: Array<{ id: string; consumed: boolean }> = []
        manager.view.setOnSettled((snap, consumed) =>
            settled.push({ id: snap.id, consumed })
        )

        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('Say hello'))
        )
        assert.equal(snap.status, 'running')
        assert.equal(snap.backend, 'pi')

        await runTool(runtime, manager.waitFor([snap.id]))
        const done = manager.view.get(snap.id)
        assert.equal(done?.status, 'done')
        assert.match(done?.finalText ?? '', /\[stub:pi\] completed: Say hello/)
        assert.deepEqual(settled, [{ id: snap.id, consumed: false }])
    })
})

test('spawned tasks expose metadata and reject active name collisions', async () => {
    await withManager(async (manager, runtime) => {
        const first = await runTool(
            runtime,
            manager.spawn(
                'pi',
                task('First task', { taskName: 'Audit API', role: 'reviewer' })
            )
        )
        assert.equal(first.taskName, 'audit-api')
        assert.equal(first.role, 'reviewer')
        assert.equal(first.version, 1)

        await assert.rejects(
            runTool(
                runtime,
                manager.spawn(
                    'pi',
                    task('Second task', {
                        taskName: 'audit-api',
                        role: 'worker',
                    })
                )
            ),
            /already in use/
        )
        await assert.rejects(
            runTool(
                runtime,
                manager.spawn('pi', task('Unknown role', { role: 'writer' }))
            ),
            /Unknown subagent role/
        )
        await runTool(runtime, manager.waitFor([first.id]))
        assert.ok((manager.view.get(first.id)?.version ?? 0) > 1)
    })
})

test('failed Pi subagents settle as unconsumed errors', async () => {
    await withManager(async (manager, runtime) => {
        const settled: Array<{ id: string; consumed: boolean }> = []
        manager.view.setOnSettled((snap, consumed) =>
            settled.push({ id: snap.id, consumed })
        )

        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('FAIL: blow up please'))
        )
        while (manager.view.get(snap.id)?.status === 'running') {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.equal(manager.view.get(snap.id)?.status, 'error')
        assert.match(manager.view.get(snap.id)?.errorText ?? '', /task failed/)
        assert.deepEqual(settled, [{ id: snap.id, consumed: false }])
    })
})

test('settlements publish one mailbox envelope for explicit consumption', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('Mailbox'))
        )
        await runTool(runtime, manager.waitFor([snap.id]))

        const events = manager.drainMailbox({ agentIds: [snap.id] })
        assert.equal(events.length, 1)
        assert.deepEqual(
            {
                agentId: events[0]?.agentId,
                taskName: events[0]?.taskName,
                role: events[0]?.role,
                kind: events[0]?.kind,
            },
            {
                agentId: snap.id,
                taskName: 'mailbox',
                role: 'default',
                kind: 'result',
            }
        )
        assert.equal(manager.drainMailbox({ agentIds: [snap.id] }).length, 0)
        assert.equal(
            manager.view.get(snap.id)?.lastMailboxSequence,
            events[0]?.sequence
        )
    })
})

test('cancel interrupts a running Pi subagent', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('Long running task'))
        )
        const report = await runTool(runtime, manager.cancel([snap.id]))
        assert.deepEqual(report, [
            { id: snap.id, title: 'test', status: 'error', cancelled: true },
        ])
    })
})

test('the concurrency cap rejects a ninth running Pi subagent', async () => {
    await withManager(async (manager, runtime) => {
        const spawns = await runTool(
            runtime,
            Effect.forEach(
                [1, 2, 3, 4, 5, 6, 7, 8],
                (n) => manager.spawn('pi', task(`Task ${n}`)),
                { concurrency: 'unbounded' }
            )
        )
        assert.equal(spawns.length, 8)
        await assert.rejects(
            runTool(runtime, manager.spawn('pi', task('Task 9'))),
            /Max 8 subagents/
        )
    })
})

test('cancel interrupts an idle restart before RunStarted reaches the manager', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(runtime, manager.spawn('pi', task('First')))
        await runTool(runtime, manager.waitFor([snap.id]))

        await runTool(runtime, manager.send(snap.id, 'Restart', 'follow-up'))
        assert.equal(manager.view.get(snap.id)?.status, 'running')
        const report = await runTool(runtime, manager.cancel([snap.id]))
        assert.equal(report[0]?.cancelled, true)
        assert.equal(manager.view.get(snap.id)?.status, 'error')
        // The stale completion remains in the mailbox, but the queued restart
        // was stopped before it could mutate the working tree.
    })
})

test('spawn rejects prompts above the byte limit', async () => {
    await withManager(async (manager, runtime) => {
        await assert.rejects(
            runTool(
                runtime,
                manager.spawn(
                    'pi',
                    task('x'.repeat(MAX_SPAWN_PROMPT_BYTES + 1))
                )
            ),
            /prompt exceeds/
        )
    })
})

test('idle Pi subagents can start another turn', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('First turn'))
        )
        await runTool(runtime, manager.waitFor([snap.id]))

        await runTool(runtime, manager.send(snap.id, 'Second turn'))
        await runTool(runtime, manager.waitFor([snap.id]))
        assert.match(manager.view.get(snap.id)?.finalText ?? '', /Second turn/)
    })
})
