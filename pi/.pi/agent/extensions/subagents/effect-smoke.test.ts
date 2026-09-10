/**
 * Effect v4 host-contract smoke test (pinned: effect@4.0.0-beta.98).
 * Proves every primitive the subagents runtime relies on before any
 * orchestration code runs: Layer construction, Scope finalizers, Fiber
 * interruption, Queue, PubSub, Deferred, and Ref.
 *
 * Note: config decoding intentionally uses explicit validators instead
 * of Schema to avoid beta API churn; the constructor spellings below
 * are the pinned v4 forms (forkScoped, andThen, forkIn(self, scope)).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    Context,
    Deferred,
    Effect,
    Exit,
    Fiber,
    Layer,
    ManagedRuntime,
    PubSub,
    Queue,
    Ref,
} from 'effect'

interface SmokeShape {
    events: string[]
}

class SmokeStore extends Context.Service<SmokeStore, SmokeShape>()(
    'subagents-smoke/Store'
) {}

const SmokeLive = Layer.succeed(SmokeStore, { events: [] })

describe('effect v4 host contract', () => {
    it('builds layers, scopes, fibers, queues, pubsub, deferreds, and refs', async () => {
        const runtime = ManagedRuntime.make(SmokeLive)
        try {
            const exit = await runtime.runPromiseExit(
                Effect.scoped(
                    Effect.gen(function* () {
                        const store = yield* SmokeStore
                        // Scope finalizer.
                        yield* Effect.addFinalizer(() =>
                            Effect.sync(() => {
                                store.events.push('finalized')
                            })
                        )
                        // Ref.
                        const ref = yield* Ref.make(0)
                        yield* Ref.update(ref, (n) => n + 1)
                        // Deferred.
                        const gate = yield* Deferred.make<string>()
                        yield* Deferred.succeed(gate, 'open')
                        const gateValue = yield* Deferred.await(gate)
                        // Queue.
                        const queue = yield* Queue.unbounded<string>()
                        yield* Queue.offer(queue, 'mail')
                        const queued = yield* Queue.take(queue)
                        // PubSub wake-up signal.
                        const bus = yield* PubSub.unbounded<string>()
                        const published = yield* PubSub.publish(bus, 'activity')
                        // Fiber interruption.
                        const started = yield* Deferred.make<boolean>()
                        const stopped = yield* Deferred.make<string>()
                        const fiber = yield* Effect.forkScoped(
                            Effect.andThen(
                                Deferred.succeed(started, true),
                                Effect.sleep(60_000)
                            ).pipe(
                                Effect.onInterrupt(() =>
                                    Deferred.succeed(stopped, 'interrupted')
                                )
                            )
                        )
                        yield* Deferred.await(started)
                        yield* Fiber.interrupt(fiber)
                        const stopReason = yield* Deferred.await(stopped)
                        store.events.push('ran')
                        return {
                            gateValue,
                            queued,
                            published,
                            stopReason,
                            count: yield* Ref.get(ref),
                            events: store.events,
                        }
                    })
                )
            )
            assert.equal(Exit.isSuccess(exit), true)
            if (Exit.isSuccess(exit)) {
                assert.deepEqual(exit.value, {
                    gateValue: 'open',
                    queued: 'mail',
                    published: true,
                    stopReason: 'interrupted',
                    count: 1,
                    events: ['ran', 'finalized'],
                })
            }
        } finally {
            await runtime.dispose()
        }
    })
})
