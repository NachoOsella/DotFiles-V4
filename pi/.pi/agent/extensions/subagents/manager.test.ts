/**
 * End-to-end smoke tests for manager behavior through a real ManagedRuntime.
 * The registry uses a scripted Pi backend so lifecycle tests do not require
 * provider credentials or make network calls.
 */

import * as path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Cause, Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect'
import {
    BackendRegistry,
    type BackendCloseResult,
    type SubagentBackend,
    type SubagentSession,
} from './src/backend.ts'
import { makeStubBackend } from './src/backends/stub.ts'
import type { SubagentConfig } from './src/config.ts'
import { SendError } from './src/domain.ts'
import type {
    BackendName,
    ParentContext,
    SpawnTask,
    SubagentEvent,
} from './src/domain.ts'
import {
    MAX_SPAWN_PROMPT_BYTES,
    SubagentManager,
    makeSubagentManagerLayer,
    type SubagentManagerShape,
} from './src/manager.ts'
import { runTool } from './src/runtime.ts'

const createTestRegistry = (
    backend: SubagentBackend = makeStubBackend({
        backend: 'pi',
        defaultModelLabel: 'pi/test-model',
        contextWindow: 128_000,
        toolName: 'bash',
        cadenceMs: 30,
    })
) =>
    Layer.sync(
        BackendRegistry,
        () => new Map<BackendName, SubagentBackend>([[backend.name, backend]])
    )

const TestRegistryLive = createTestRegistry()

const createTestRuntime = (
    config?: SubagentConfig,
    registry = TestRegistryLive
) =>
    ManagedRuntime.make(
        makeSubagentManagerLayer(config).pipe(Layer.provide(registry))
    )

const failingLifecycleBackend: SubagentBackend = {
    name: 'pi',
    capabilities: {
        steering: true,
        modelSelection: false,
        reasoningEffort: false,
    },
    available: Effect.succeed(true),
    spawn: () =>
        Effect.succeed({
            meta: Effect.succeed({ backend: 'pi', modelLabel: 'fake' }),
            events: Stream.never,
            send: () =>
                Effect.fail(
                    new SendError({ message: 'fake session is unavailable' })
                ),
            interrupt: Effect.fail(
                new Error('fake interrupt failed')
            ) as unknown as Effect.Effect<void>,
            close: Effect.fail(
                new Error('fake close failed')
            ) as unknown as Effect.Effect<BackendCloseResult>,
        } satisfies SubagentSession),
}

const parent: ParentContext = {
    parentCwd: process.cwd(),
    projectTrusted: false,
}

function makeGatedBackend() {
    let current:
        | {
              emit(event: SubagentEvent): Promise<void>
              end(): Promise<void>
              ask(message: string): void
              sent: Array<{ text: string; runId?: string }>
          }
        | undefined
    const sessions = new Map<string, NonNullable<typeof current>>()
    const backend: SubagentBackend = {
        name: 'pi',
        capabilities: {
            steering: true,
            modelSelection: false,
            reasoningEffort: false,
        },
        available: Effect.succeed(true),
        spawn: (spawnTask) =>
            Effect.gen(function* () {
                const events = yield* Queue.make<SubagentEvent, Cause.Done>()
                const sent: Array<{ text: string; runId?: string }> = []
                current = {
                    sent,
                    ask: (message) => spawnTask.reportToParent?.(message),
                    emit: (event) =>
                        Effect.runPromise(Queue.offer(events, event)).then(
                            () => undefined
                        ),
                    end: () =>
                        Effect.runPromise(Queue.end(events)).then(
                            () => undefined
                        ),
                }
                if (spawnTask.agentId) sessions.set(spawnTask.agentId, current)
                return {
                    meta: Effect.succeed({
                        backend: 'pi',
                        modelLabel: 'gated',
                    }),
                    events: Stream.fromQueue(events),
                    send: (text: string, _delivery, runId?: string) =>
                        Effect.sync(() => sent.push({ text, runId })),
                    interrupt: Effect.void,
                    close: Effect.gen(function* () {
                        yield* Queue.end(events).pipe(Effect.ignore)
                        return {
                            terminal: true,
                            resourcesReleased: true,
                        } as const
                    }),
                } satisfies SubagentSession
            }),
    }
    return {
        backend,
        session: () => {
            if (!current) throw new Error('gated session was not spawned')
            return current
        },
        sessionFor: (id: string) => {
            const session = sessions.get(id)
            if (!session) throw new Error(`gated session was not spawned: ${id}`)
            return session
        },
    }
}

function task(
    prompt: string,
    overrides: Partial<
        Pick<SpawnTask, 'taskName' | 'role' | 'title' | 'ownedPaths'>
    > = {}
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
    ) => Promise<void>,
    config?: SubagentConfig,
    registry = TestRegistryLive
) {
    const runtime = createTestRuntime(config, registry)
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
        assert.equal(manager.getMetrics().agentsSpawned, 1)
        assert.equal(manager.getMetrics().immediateWaits, 1)
        const done = manager.view.get(snap.id)
        assert.equal(done?.status, 'done')
        assert.match(done?.finalText ?? '', /\[stub:pi\] completed: Say hello/)
        assert.deepEqual(settled, [{ id: snap.id, consumed: true }])
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
        const waitResult = await runTool(runtime, manager.waitFor([snap.id]))

        const events = waitResult.events
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

test('configured concurrency limits apply to the manager', async () => {
    const config: SubagentConfig = {
        maxRunning: 2,
        maxTracked: 64,
        roleModels: {},
        roleReasoningEfforts: {},
    }
    await withManager(async (manager, runtime) => {
        await runTool(runtime, manager.spawn('pi', task('One')))
        await runTool(runtime, manager.spawn('pi', task('Two')))
        await assert.rejects(
            runTool(runtime, manager.spawn('pi', task('Three'))),
            /Max 2 subagents/
        )
    }, config)
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

test('forced interrupt failure makes the session terminal', async () => {
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn('pi', task('Uninterruptible'))
            )
            const report = await runTool(runtime, manager.interrupt([snap.id]))
            assert.equal(report[0]?.cancelled, true)
            assert.equal(manager.view.get(snap.id)?.status, 'closed')
            await assert.rejects(
                runTool(runtime, manager.send(snap.id, 'Try again')),
                /permanently closed/
            )
        },
        undefined,
        createTestRegistry(failingLifecycleBackend)
    )
})

test('close reports incomplete resource release', async () => {
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn('pi', task('Unclosable'))
            )
            const report = await runTool(runtime, manager.close([snap.id]))
            assert.equal(report[0]?.closed, false)
            assert.equal(manager.view.get(snap.id)?.status, 'closed')
        },
        undefined,
        createTestRegistry(failingLifecycleBackend)
    )
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

test('ID waits stay pending across the settle-to-queued-run transition', async () => {
    const gated = makeGatedBackend()
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn(
                    'pi',
                    task('first run', { taskName: 'gated-wait' })
                )
            )
            const firstRunId = snap.currentRunId
            assert.ok(firstRunId)
            await runTool(runtime, manager.send(snap.id, 'second run'))
            await runTool(runtime, manager.send(snap.id, 'third run'))
            const waiting = runTool(runtime, manager.waitFor([snap.id]))
            let waitFinished = false
            void waiting.then(() => {
                waitFinished = true
            })

            await gated.session().emit({
                _tag: 'RunSettled',
                runId: firstRunId,
                outcome: { _tag: 'Completed', finalText: 'first output' },
            })
            while (manager.view.get(snap.id)?.status !== 'done')
                await new Promise((resolve) => setImmediate(resolve))
            await new Promise((resolve) => setImmediate(resolve))
            assert.equal(waitFinished, false)

            const secondRunId = gated.session().sent[0]?.runId
            const thirdRunId = gated.session().sent[1]?.runId
            assert.ok(secondRunId)
            assert.ok(thirdRunId)
            assert.notEqual(secondRunId, thirdRunId)
            await gated
                .session()
                .emit({ _tag: 'RunStarted', runId: secondRunId })
            await gated.session().emit({
                _tag: 'RunSettled',
                runId: secondRunId,
                outcome: { _tag: 'Completed', finalText: 'second output' },
            })
            await new Promise((resolve) => setImmediate(resolve))
            assert.equal(waitFinished, false)

            await gated
                .session()
                .emit({ _tag: 'RunStarted', runId: thirdRunId })
            await gated.session().emit({
                _tag: 'RunSettled',
                runId: thirdRunId,
                outcome: { _tag: 'Completed', finalText: 'third output' },
            })
            const result = await waiting
            assert.deepEqual(result.pending, [])
            assert.deepEqual(result.completed, [snap.id])
            assert.equal(manager.view.get(snap.id)?.lastRun?.id, thirdRunId)
            const stableOutput = manager.view.get(snap.id)?.finalText
            await gated.session().emit({
                _tag: 'RunStarted',
                runId: secondRunId,
            })
            await gated.session().emit({
                _tag: 'RunSettled',
                runId: secondRunId,
                outcome: { _tag: 'Failed', errorText: 'late failure' },
            })
            assert.equal(manager.view.get(snap.id)?.finalText, stableOutput)
            assert.equal(manager.view.get(snap.id)?.lastRun?.id, thirdRunId)
        },
        undefined,
        createTestRegistry(gated.backend)
    )
})

test('an ended backend stream fails queued runs instead of stranding a wait', async () => {
    const gated = makeGatedBackend()
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn('pi', task('first run', { taskName: 'gated-end' }))
            )
            const firstRunId = snap.currentRunId
            assert.ok(firstRunId)
            await runTool(runtime, manager.send(snap.id, 'queued run'))
            const waiting = runTool(runtime, manager.waitFor([snap.id]))
            await gated.session().emit({
                _tag: 'RunSettled',
                runId: firstRunId,
                outcome: { _tag: 'Completed', finalText: 'first output' },
            })
            await gated.session().end()
            const result = await waiting
            assert.deepEqual(result.pending, [])
            assert.equal(manager.view.get(snap.id)?.status, 'error')
            assert.match(
                manager.view.get(snap.id)?.errorText ?? '',
                /queued run/
            )
        },
        undefined,
        createTestRegistry(gated.backend)
    )
})

test('interrupt discards queued follow-ups after the prior run settles', async () => {
    const gated = makeGatedBackend()
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn(
                    'pi',
                    task('first run', { taskName: 'gated-interrupt' })
                )
            )
            const firstRunId = snap.currentRunId
            assert.ok(firstRunId)
            await runTool(runtime, manager.send(snap.id, 'queued run'))
            await gated.session().emit({
                _tag: 'RunSettled',
                runId: firstRunId,
                outcome: { _tag: 'Completed', finalText: 'first output' },
            })
            while (manager.view.get(snap.id)?.status !== 'done')
                await new Promise((resolve) => setImmediate(resolve))

            const report = await runTool(runtime, manager.interrupt([snap.id]))
            assert.equal(report[0]?.cancelled, true)
            const after = manager.view.get(snap.id)
            assert.equal(after?.status, 'error')
            assert.equal(after?.lastRun?.status, 'interrupted')
            assert.equal(after?.lastRun?.id, gated.session().sent[0]?.runId)
            await gated.session().emit({
                _tag: 'RunStarted',
                runId: after?.lastRun?.id ?? '',
            })
            assert.equal(
                manager.view.get(snap.id)?.lastRun?.status,
                'interrupted'
            )
        },
        undefined,
        createTestRegistry(gated.backend)
    )
})

test('close makes a queued follow-up terminal without starting it', async () => {
    const gated = makeGatedBackend()
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn('pi', task('first run', { taskName: 'gated-close' }))
            )
            const firstRunId = snap.currentRunId
            assert.ok(firstRunId)
            await runTool(runtime, manager.send(snap.id, 'queued run'))
            await gated.session().emit({
                _tag: 'RunSettled',
                runId: firstRunId,
                outcome: { _tag: 'Completed', finalText: 'first output' },
            })
            while (manager.view.get(snap.id)?.status !== 'done')
                await new Promise((resolve) => setImmediate(resolve))

            const report = await runTool(runtime, manager.close([snap.id]))
            assert.equal(report[0]?.terminal, true)
            assert.equal(report[0]?.resourcesReleased, true)
            assert.equal(manager.view.get(snap.id)?.status, 'closed')
            assert.equal(gated.session().sent.length, 1)
            await assert.rejects(
                runTool(runtime, manager.send(snap.id, 'after close')),
                /closed/
            )
        },
        undefined,
        createTestRegistry(gated.backend)
    )
})

test('idle Pi subagents can start another turn with a distinct run id', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('First turn'))
        )
        await runTool(runtime, manager.waitFor([snap.id]))
        const firstRunId = manager.view.get(snap.id)?.lastRun?.id

        await runTool(runtime, manager.send(snap.id, 'Second turn'))
        await runTool(runtime, manager.waitFor([snap.id]))
        const second = manager.view.get(snap.id)
        assert.match(second?.finalText ?? '', /Second turn/)
        assert.notEqual(second?.lastRun?.id, firstRunId)
        assert.equal(second?.currentRunId, second?.lastRun?.id)
    })
})

test('a failed later run cannot return stale output', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('First turn'))
        )
        await runTool(runtime, manager.waitFor([snap.id]))
        assert.match(manager.view.get(snap.id)?.finalText ?? '', /First turn/)

        await runTool(runtime, manager.send(snap.id, 'FAIL: second turn'))
        await runTool(runtime, manager.waitFor([snap.id]))
        const second = manager.view.get(snap.id)
        assert.equal(second?.status, 'error')
        assert.equal(second?.finalText, '')
        assert.equal(second?.lastRun?.status, 'failed')
        assert.notEqual(second?.lastRun?.id, undefined)
    })
})

test('ID waits finish when a child fails', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('FAIL: wait failure'))
        )
        const result = await runTool(runtime, manager.waitFor([snap.id]))
        assert.equal(result.timedOut, false)
        assert.deepEqual(result.pending, [])
        assert.deepEqual(result.completed, [snap.id])
        assert.equal(manager.view.get(snap.id)?.status, 'error')
    })
})

test('ID waits wake on a requested child question without settling other work', async () => {
    const gated = makeGatedBackend()
    await withManager(
        async (manager, runtime) => {
            const first = await runTool(
                runtime,
                manager.spawn('pi', task('A', { taskName: 'question-a' }))
            )
            const second = await runTool(
                runtime,
                manager.spawn('pi', task('B', { taskName: 'question-b' }))
            )
            const third = await runTool(
                runtime,
                manager.spawn('pi', task('C', { taskName: 'question-c' }))
            )
            const waiting = runTool(
                runtime,
                manager.waitFor([first.id, second.id, third.id])
            )
            await new Promise((resolve) => setImmediate(resolve))
            gated.sessionFor(first.id).ask('Need a parent decision')

            let questionTimeout: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_, reject) => {
                questionTimeout = setTimeout(
                    () => reject(new Error('question did not wake wait')),
                    100
                )
            })
            const result = await Promise.race([waiting, timeout])
            if (questionTimeout) clearTimeout(questionTimeout)
            assert.deepEqual(result.pending, [first.id, second.id, third.id])
            assert.deepEqual(result.completed, [])
            assert.equal(result.timedOut, false)
            assert.deepEqual(
                result.events.map((event) => [event.kind, event.text]),
                [['question', 'Need a parent decision']]
            )
            assert.equal(manager.view.get(first.id)?.status, 'running')
            assert.equal(manager.view.get(second.id)?.status, 'running')
            assert.equal(manager.view.get(third.id)?.status, 'running')
        },
        undefined,
        createTestRegistry(gated.backend)
    )
})

test('zero-timeout ID waits return an already pending question', async () => {
    const gated = makeGatedBackend()
    await withManager(
        async (manager, runtime) => {
            const snap = await runTool(
                runtime,
                manager.spawn('pi', task('Question first'))
            )
            gated.sessionFor(snap.id).ask('Which option should I choose?')

            const result = await runTool(
                runtime,
                manager.waitFor([snap.id], undefined, 0)
            )
            assert.equal(result.timedOut, false)
            assert.deepEqual(result.pending, [snap.id])
            assert.deepEqual(
                result.events.map((event) => [event.kind, event.text]),
                [['question', 'Which option should I choose?']]
            )
        },
        undefined,
        createTestRegistry(gated.backend)
    )
})

test('ID waits respect timeout and leave pending agents running', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('Long task'))
        )
        const result = await runTool(
            runtime,
            manager.waitFor([snap.id], undefined, 0)
        )
        assert.equal(result.timedOut, true)
        assert.deepEqual(result.pending, [snap.id])
        assert.equal(manager.view.get(snap.id)?.status, 'running')
        await runTool(runtime, manager.interrupt([snap.id]))
    })
})

test('configured role models override inherited model defaults', async () => {
    const config: SubagentConfig = {
        maxRunning: 2,
        maxTracked: 64,
        roleModels: {
            explorer: 'cheap/explorer',
            tester: 'cheap/tester',
            worker: 'capable/worker',
            reviewer: 'capable/reviewer',
        },
        roleReasoningEfforts: {
            explorer: 'minimal',
            tester: 'low',
            worker: 'high',
            reviewer: 'high',
        },
    }
    await withManager(async (manager, runtime) => {
        const explorer = await runTool(
            runtime,
            manager.spawn('pi', task('Explore', { role: 'explorer' }))
        )
        const worker = await runTool(
            runtime,
            manager.spawn('pi', task('Work', { role: 'worker' }))
        )
        assert.equal(explorer.meta.modelLabel, 'cheap/explorer')
        assert.equal(explorer.meta.thinkingLevel, 'minimal')
        assert.equal(worker.meta.modelLabel, 'capable/worker')
        assert.equal(worker.meta.thinkingLevel, 'high')
        await runTool(runtime, manager.interrupt([explorer.id, worker.id]))
    }, config)
})

test('spawning overlapping owned paths reports a warning', async () => {
    await withManager(async (manager, runtime) => {
        const first = await runTool(
            runtime,
            manager.spawn(
                'pi',
                task('First owner', { ownedPaths: ['src/auth/**'] })
            )
        )
        const second = await runTool(
            runtime,
            manager.spawn(
                'pi',
                task('Second owner', { ownedPaths: ['src/auth/login.ts'] })
            )
        )
        assert.deepEqual(first.ownedPaths, [
            path.resolve(process.cwd(), 'src/auth/**'),
        ])
        assert.match(second.ownershipWarning ?? '', /sa-1/)
        await runTool(runtime, manager.interrupt([first.id, second.id]))
    })
})

test('interrupt keeps a subagent reusable', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('Stop me'))
        )
        await runTool(runtime, manager.interrupt([snap.id]))
        await runTool(runtime, manager.send(snap.id, 'Run again'))
        await runTool(runtime, manager.waitFor([snap.id]))
        assert.equal(manager.view.get(snap.id)?.status, 'done')
        assert.match(manager.view.get(snap.id)?.finalText ?? '', /Run again/)
    })
})

test('closed subagents reject future sends', async () => {
    await withManager(async (manager, runtime) => {
        const snap = await runTool(
            runtime,
            manager.spawn('pi', task('Close me'))
        )
        const report = await runTool(runtime, manager.close([snap.id]))
        assert.equal(report[0]?.closed, true)
        assert.equal(manager.view.get(snap.id)?.status, 'closed')
        await assert.rejects(
            runTool(runtime, manager.send(snap.id, 'Do not run')),
            /no longer tracked|closed/
        )
    })
})
