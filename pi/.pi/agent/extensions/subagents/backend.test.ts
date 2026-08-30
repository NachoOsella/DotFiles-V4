import assert from 'node:assert/strict'
import test from 'node:test'
import { Duration, Effect, Ref, Stream } from 'effect'
import { CHILD_EXCLUDED_TOOL_NAMES } from './src/backends/pi.ts'
import { makeStubBackend } from './src/backends/stub.ts'
import type { ParentContext, SpawnTask, SubagentEvent } from './src/domain.ts'

const parent: ParentContext = {
    parentCwd: process.cwd(),
    projectTrusted: false,
}

const task: SpawnTask = {
    prompt: 'Initial task',
    title: 'backend test',
    cwd: process.cwd(),
    parent,
}

test('stub session preserves steer and follow-up queue semantics', async () => {
    const backend = makeStubBackend({
        backend: 'pi',
        defaultModelLabel: 'pi/test-model',
        contextWindow: 128_000,
        toolName: 'bash',
        cadenceMs: 100,
    })

    const events = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* backend.spawn(task)
                const seen = yield* Ref.make<ReadonlyArray<SubagentEvent>>([])
                yield* Stream.runForEach(session.events, (event) =>
                    Ref.update(seen, (current) => [...current, event])
                ).pipe(Effect.forkScoped)

                // The initial turn pauses after its first delta, leaving it active.
                yield* Effect.sleep(Duration.millis(20))
                yield* session.send(
                    'Ask this after the current turn',
                    'follow-up'
                )
                yield* session.send('Change direction')
                yield* Effect.sleep(Duration.millis(20))
                return yield* Ref.get(seen)
            })
        )
    )

    const queued = events.find(
        (event): event is Extract<SubagentEvent, { _tag: 'QueueChanged' }> =>
            event._tag === 'QueueChanged' && event.queued.length === 2
    )
    assert.deepEqual(queued?.queued, [
        { text: 'Ask this after the current turn', kind: 'follow-up' },
        { text: 'Change direction', kind: 'steer' },
    ])
})

test('Pi children exclude orchestration tools', () => {
    assert.deepEqual(
        CHILD_EXCLUDED_TOOL_NAMES.filter((name) =>
            name.startsWith('subagent_')
        ),
        [
            'subagent_spawn',
            'subagent_wait',
            'subagent_cancel',
            'subagent_send',
            'subagent_check',
            'subagent_list',
        ]
    )
})
