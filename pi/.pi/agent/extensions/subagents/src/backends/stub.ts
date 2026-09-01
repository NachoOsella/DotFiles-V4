/**
 * Scripted Pi sessions for deterministic manager and UI tests. A stub session:
 *
 * - streams a plausible turn (thinking deltas, one fake tool cycle, text
 *   deltas, usage ramp, a final assistant message, RunSettled) over a few
 *   seconds so streaming UI, wait, and the footer counters are observable;
 * - supports steer and follow-up queue rendering while running, and a fresh
 *   turn while idle;
 * - supports interrupt (RunSettled Interrupted -> status "error", matching v1);
 * - fails the run when the prompt starts with "FAIL:" (error-path testing);
 * - appends every event to a JSONL "session file" in tmpdir so the
 *   "full transcript in session file" pointers resolve.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Cause, Scope } from 'effect'
import { Duration, Effect, Fiber, Queue, Ref, Stream } from 'effect'
import type {
    SendDelivery,
    SubagentBackend,
    SubagentSession,
} from '../backend.ts'
import type {
    BackendName,
    QueuedMessage,
    SpawnTask,
    SubagentEvent,
    SubagentMeta,
} from '../domain.ts'
import { SendError } from '../domain.ts'

export interface StubProfile {
    readonly backend: BackendName
    readonly defaultModelLabel: string
    readonly contextWindow: number
    readonly toolName: string
    /** Delay between scripted events. */
    readonly cadenceMs: number
}

const STUB_DIR = path.join(os.tmpdir(), 'subagents-stub')
let sessionCounter = 0

export function makeStubBackend(profile: StubProfile): SubagentBackend {
    return {
        name: profile.backend,
        capabilities: {
            steering: true,
            modelSelection: true,
            reasoningEffort: true,
        },
        // The test backend is always available.
        available: Effect.succeed(true),
        spawn: (task) => makeStubSession(profile, task),
    }
}

function firstLine(text: string): string {
    return (
        text
            .split('\n')
            .find((line) => line.trim())
            ?.trim() ?? ''
    )
}

function chunked(text: string, size: number): string[] {
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += size)
        chunks.push(text.slice(i, i + size))
    return chunks
}

const makeStubSession = (
    profile: StubProfile,
    task: SpawnTask
): Effect.Effect<SubagentSession, never, Scope.Scope> =>
    Effect.gen(function* () {
        const sessionId = `stub-${profile.backend}-${++sessionCounter}`
        const sessionFile = path.join(STUB_DIR, `${sessionId}.jsonl`)

        const state = {
            meta: {
                backend: profile.backend,
                modelLabel: task.model ?? profile.defaultModelLabel,
                thinkingLevel:
                    task.reasoningEffort ?? task.parent.inheritedThinkingLevel,
                contextWindow: profile.contextWindow,
                sessionFilePath: sessionFile,
            } satisfies SubagentMeta as SubagentMeta,
            pending: [] as QueuedMessage[],
            turnCount: 0,
            closed: false,
            /** True between the driver dequeuing a prompt and registering its turn fiber. */
            dispatching: false,
            runCounter: 0,
            activeRunId: undefined as string | undefined,
        }

        const events = yield* Queue.make<SubagentEvent, Cause.Done>()
        const inbox = yield* Queue.make<QueuedMessage, Cause.Done>()
        const activeTurn = yield* Ref.make<Fiber.Fiber<void> | undefined>(
            undefined
        )

        const emit = (event: SubagentEvent) =>
            Effect.suspend(() => {
                try {
                    fs.appendFileSync(sessionFile, `${JSON.stringify(event)}\n`)
                } catch {
                    // The fake session file is best-effort.
                }
                if (event._tag === 'MetaChanged') {
                    state.meta = { ...state.meta, ...event.meta }
                }
                return Queue.offer(events, event)
            }).pipe(Effect.asVoid)

        const pause = Effect.sleep(Duration.millis(profile.cadenceMs))

        const nextRunId = () =>
            `${task.agentId ?? sessionId}:run-${++state.runCounter}`

        const runTurn = (userText: string, turn: number, runId: string) =>
            Effect.gen(function* () {
                state.activeRunId = runId
                yield* emit({ _tag: 'RunStarted', runId })
                const failing = userText.trimStart().startsWith('FAIL:')

                const thinking =
                    'Looking at the task and planning an approach...'
                for (const delta of chunked(thinking, 16)) {
                    yield* emit({
                        _tag: 'AssistantDelta',
                        kind: 'thinking',
                        delta,
                        runId,
                    })
                    yield* pause
                }

                const toolId = `${sessionId}-tool-${turn}`
                const argsPreview = `{"command":"ls ${task.cwd}"}`
                yield* emit({
                    _tag: 'AssistantMessage',
                    parts: [
                        { type: 'thinking', text: thinking },
                        {
                            type: 'text',
                            text: `I'll run ${profile.toolName} to look around first.`,
                        },
                        {
                            type: 'toolCall',
                            toolId,
                            name: profile.toolName,
                            argsPreview,
                        },
                    ],
                    runId,
                })
                yield* emit({
                    _tag: 'ToolStart',
                    toolId,
                    name: profile.toolName,
                    argsPreview,
                    runId,
                })
                yield* pause
                yield* emit({
                    _tag: 'ToolUpdate',
                    toolId,
                    outputPreview: 'src docs package.json',
                    runId,
                })
                yield* pause
                yield* emit({
                    _tag: 'ToolEnd',
                    toolId,
                    name: profile.toolName,
                    isError: false,
                    outputPreview: 'src docs package.json',
                    runId,
                })
                yield* emit({
                    _tag: 'UsageChanged',
                    tokens: Math.min(profile.contextWindow, 2400 * (turn + 1)),
                    contextWindow: profile.contextWindow,
                    runId,
                })

                if (failing) {
                    yield* pause
                    yield* emit({
                        _tag: 'RunSettled',
                        runId,
                        outcome: {
                            _tag: 'Failed',
                            errorText: `[stub:${profile.backend}] task failed as requested by FAIL: prefix`,
                        },
                    })
                    state.activeRunId = undefined
                    return
                }

                const finalText =
                    `[stub:${profile.backend}] completed: ${firstLine(userText).slice(0, 200)}\n\n` +
                    `This is a stubbed ${profile.backend} subagent turn ${turn + 1}. ` +
                    `The real backend integration will replace this scripted output.`
                for (const delta of chunked(finalText, 24)) {
                    yield* emit({
                        _tag: 'AssistantDelta',
                        kind: 'text',
                        delta,
                        runId,
                    })
                    yield* pause
                }
                yield* emit({
                    _tag: 'AssistantMessage',
                    parts: [{ type: 'text', text: finalText }],
                    runId,
                })
                yield* emit({
                    _tag: 'UsageChanged',
                    tokens: Math.min(
                        profile.contextWindow,
                        2400 * (turn + 1) + 900
                    ),
                    contextWindow: profile.contextWindow,
                    runId,
                })
                yield* emit({
                    _tag: 'RunSettled',
                    runId,
                    outcome: { _tag: 'Completed', finalText },
                })
                state.activeRunId = undefined
            })

        const queuedView = (): ReadonlyArray<QueuedMessage> => state.pending

        // Driver: one turn at a time, in submission order. Turns run as child
        // fibers so interrupt() stops the turn without killing the driver.
        const driver = Effect.gen(function* () {
            while (true) {
                const message = yield* Queue.take(inbox)
                state.dispatching = true
                state.pending.shift()
                const turn = state.turnCount++
                const runId = message.runId ?? nextRunId()
                yield* emit({
                    _tag: 'QueueChanged',
                    queued: queuedView(),
                    runId,
                })
                yield* emit({
                    _tag: 'UserMessage',
                    text: message.text,
                    runId,
                })
                const fiber = yield* Effect.forkChild(
                    runTurn(message.text, turn, runId).pipe(
                        Effect.onInterrupt(() =>
                            emit({
                                _tag: 'RunSettled',
                                runId,
                                outcome: { _tag: 'Interrupted' },
                            }).pipe(Effect.ignore)
                        )
                    )
                )
                yield* Ref.set(activeTurn, fiber)
                state.dispatching = false
                yield* Fiber.await(fiber)
                state.activeRunId = undefined
                yield* Ref.set(activeTurn, undefined)
            }
        })
        yield* Effect.forkScoped(driver.pipe(Effect.ignore))

        const closeSession = Effect.gen(function* () {
            state.closed = true
            yield* Queue.end(inbox).pipe(Effect.ignore)
            yield* Queue.end(events).pipe(Effect.ignore)
            return {
                terminal: true,
                resourcesReleased: true,
            } as const
        })
        yield* Effect.addFinalizer(() => closeSession)

        const submit = (
            text: string,
            delivery: SendDelivery = 'follow-up',
            runId?: string
        ) =>
            Effect.gen(function* () {
                if (state.closed) {
                    return yield* new SendError({
                        message: 'Subagent session is closed.',
                    })
                }
                const message = {
                    text,
                    kind: delivery,
                    ...(runId ? { runId } : {}),
                } satisfies QueuedMessage
                state.pending.push(message)
                const busy = (yield* Ref.get(activeTurn)) !== undefined
                if (busy) {
                    // Show the queued steer line until the driver picks it up.
                    yield* emit({
                        _tag: 'QueueChanged',
                        queued: queuedView(),
                        runId: state.activeRunId,
                    })
                }
                yield* Queue.offer(inbox, message)
            })

        // Announce metadata, then kick off the initial run.
        yield* Effect.try(() =>
            fs.mkdirSync(STUB_DIR, { recursive: true })
        ).pipe(
            Effect.ignore // The fake session file directory is best-effort.
        )
        yield* emit({ _tag: 'MetaChanged', meta: state.meta })
        // The session cannot be closed yet, so the initial submit cannot fail.
        yield* submit(task.prompt, 'steer', task.runId).pipe(Effect.orDie)

        return {
            meta: Effect.sync(() => state.meta),
            events: Stream.fromQueue(events),
            send: submit,
            interrupt: Effect.gen(function* () {
                // Drop queued prompts so interrupting cannot immediately start
                // another turn, then stop the active turn. A prompt may be mid-flight
                // between the driver dequeuing it and registering its fiber, so wait
                // that window out instead of silently missing the turn.
                const cleared = yield* Queue.clear(inbox).pipe(
                    Effect.orElseSucceed(() => [])
                )
                state.pending = []
                yield* emit({
                    _tag: 'QueueChanged',
                    queued: [],
                    runId: state.activeRunId,
                })
                while (true) {
                    const fiber = yield* Ref.get(activeTurn)
                    if (fiber) {
                        yield* Fiber.interrupt(fiber)
                        // The previous turn may already have emitted RunSettled while its
                        // driver still owns the active fiber. A cleared queued restart
                        // still needs a terminal event for the manager's visible run.
                        if (cleared.length > 0) {
                            yield* emit({
                                _tag: 'RunSettled',
                                runId:
                                    cleared[0]?.runId ??
                                    state.activeRunId ??
                                    nextRunId(),
                                outcome: { _tag: 'Interrupted' },
                            })
                        }
                        return
                    }
                    if (!state.dispatching) {
                        // No turn ever started. If we cancelled queued prompts, the run
                        // still needs a terminal event or it would look running forever.
                        if (cleared.length > 0) {
                            yield* emit({
                                _tag: 'RunSettled',
                                runId: cleared[0]?.runId ?? nextRunId(),
                                outcome: { _tag: 'Interrupted' },
                            })
                        }
                        return
                    }
                    yield* Effect.sleep(Duration.millis(5))
                }
            }),
            close: closeSession,
        } satisfies SubagentSession
    })
