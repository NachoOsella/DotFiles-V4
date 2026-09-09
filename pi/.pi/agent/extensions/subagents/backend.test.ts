import assert from 'node:assert/strict'
import test from 'node:test'
import { Duration, Effect, Fiber, Ref, Stream } from 'effect'
import {
    CHILD_EXCLUDED_TOOL_NAMES,
    childToolNames,
    createPiBackend,
    REPORT_TO_PARENT_MESSAGE_DESCRIPTION,
    REPORT_TO_PARENT_TOOL_DESCRIPTION,
    resolvePiModel,
    type PiSessionFactory,
} from './src/backends/pi.ts'
import {
    CODING_TOOL_NAMES,
    READ_ONLY_TOOL_NAMES,
    REVIEW_TOOL_NAMES,
    AGENT_ROLES,
} from './src/roles.ts'
import { makeStubBackend } from './src/backends/stub.ts'
import type { ParentContext, SpawnTask, SubagentEvent } from './src/domain.ts'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { Scope } from 'effect'
import type { SubagentSession } from './src/backend.ts'
import { SpawnError } from './src/domain.ts'

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

function makeMinimalSdkSession(overrides: Record<string, unknown> = {}) {
    const listeners = new Set<(event: unknown) => void>()
    return {
        messages: [],
        thinkingLevel: 'medium',
        sessionFile: undefined,
        model: undefined,
        isStreaming: false,
        sessionManager: { appendSessionInfo: async () => undefined },
        extensionRunner: {
            hasHandlers: () => false,
            emit: async () => undefined,
        },
        getContextUsage: () => undefined,
        getAllTools: () => [],
        getToolDefinition: () => undefined,
        bindExtensions: async () => undefined,
        setActiveToolsByName: () => undefined,
        setFollowUpMode: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        clearQueue: () => undefined,
        abort: async () => undefined,
        dispose: () => undefined,
        prompt: async () => undefined,
        followUp: async () => undefined,
        steer: async () => undefined,
        ...overrides,
    } as unknown as AgentSession
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
                yield* session.send('Ask this after the current turn')
                yield* session.send('Change direction', 'steer')
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
    const started = events.find(
        (event): event is Extract<SubagentEvent, { _tag: 'RunStarted' }> =>
            event._tag === 'RunStarted'
    )
    assert.ok(started)
    for (const event of events) {
        if (event._tag !== 'MetaChanged')
            assert.equal(event.runId, started.runId)
    }
})

test('Pi backend applies child filtering and aborts through the SDK session', async () => {
    let capturedOptions: Parameters<PiSessionFactory>[0] | undefined
    let activeTools: ReadonlyArray<string> = []
    let abortCalled = false
    let disposed = false
    const listeners = new Set<(event: unknown) => void>()
    const fakeSession = {
        messages: [],
        thinkingLevel: 'medium',
        sessionFile: undefined,
        model: undefined,
        isStreaming: false,
        sessionManager: {
            appendSessionInfo: async () => undefined,
        },
        extensionRunner: {
            hasHandlers: () => false,
            emit: async () => undefined,
        },
        getContextUsage: () => undefined,
        getAllTools: () =>
            [
                { name: 'safe-extension' },
                { name: 'unconfigured-extension' },
            ] as any,
        getToolDefinition: () => undefined,
        bindExtensions: async () => undefined,
        setActiveToolsByName: (names: ReadonlyArray<string>) => {
            activeTools = names
        },
        setFollowUpMode: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        clearQueue: () => undefined,
        abort: async () => {
            abortCalled = true
        },
        dispose: () => {
            disposed = true
        },
        prompt: async () => undefined,
        followUp: async () => undefined,
        steer: async () => undefined,
    } as unknown as AgentSession
    const sessionFactory: PiSessionFactory = async (options) => {
        capturedOptions = options
        return {
            session: fakeSession,
        } as Awaited<ReturnType<PiSessionFactory>>
    }
    const backend = createPiBackend({ sessionFactory })

    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* backend.spawn({
                    ...task,
                    role: 'reviewer',
                    allowedExtensionTools: [
                        'safe-extension',
                        'subagent_wait',
                        'ask_user',
                        'edit',
                    ],
                })
                assert.deepEqual(capturedOptions?.tools, [
                    ...REVIEW_TOOL_NAMES,
                    'safe-extension',
                    'subagent_wait',
                    'ask_user',
                    'edit',
                ])
                assert.ok(
                    capturedOptions?.excludeTools?.includes('subagent_spawn')
                )
                assert.deepEqual(activeTools, [
                    ...REVIEW_TOOL_NAMES,
                    'safe-extension',
                ])
                assert.equal(
                    activeTools.includes('unconfigured-extension'),
                    false
                )
                assert.equal(activeTools.includes('subagent_wait'), false)
                assert.equal(activeTools.includes('ask_user'), false)
                assert.equal(activeTools.includes('edit'), false)
                yield* session.interrupt
                assert.equal(abortCalled, true)
                const closeResult = yield* session.close
                assert.deepEqual(closeResult, {
                    terminal: true,
                    resourcesReleased: true,
                })
                const repeatedClose = yield* session.close
                assert.deepEqual(repeatedClose, closeResult)
            })
        )
    )
    assert.equal(disposed, true)
    assert.equal(listeners.size, 0)
})

test('Pi close reports shutdown hook and dispose failures without losing terminality', async () => {
    let disposed = false
    const sessionFactory: PiSessionFactory = async () =>
        ({
            session: makeMinimalSdkSession({
                extensionRunner: {
                    hasHandlers: () => true,
                    emit: async () => {
                        throw new Error('shutdown hook failed')
                    },
                },
                dispose: () => {
                    disposed = true
                    throw new Error('dispose failed')
                },
            }),
        }) as Awaited<ReturnType<PiSessionFactory>>
    const backend = createPiBackend({
        sessionFactory,
        cleanupTimeoutMs: 5,
    })

    const result = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* backend.spawn(task)
                const close = yield* session.close
                assert.equal(close.terminal, true)
                assert.equal(close.resourcesReleased, false)
                assert.match(close.error ?? '', /shutdown hook|dispose/)
                assert.equal((yield* session.close).resourcesReleased, false)
                return close
            })
        )
    )
    assert.equal(result.terminal, true)
    assert.equal(disposed, true)
})

test('Pi close reports an abort timeout while keeping the session terminal', async () => {
    const sessionFactory: PiSessionFactory = async () =>
        ({
            session: makeMinimalSdkSession({
                abort: () => new Promise<void>(() => undefined),
            }),
        }) as Awaited<ReturnType<PiSessionFactory>>
    const backend = createPiBackend({ sessionFactory, cleanupTimeoutMs: 5 })

    const close = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* backend.spawn(task)
                return yield* session.close
            })
        )
    )
    assert.equal(close.terminal, true)
    assert.equal(close.resourcesReleased, false)
    assert.match(close.error ?? '', /abort/)
})

test('model routing treats aliases as ordinary explicit model identifiers', () => {
    const explicit = {
        provider: 'provider-a',
        id: '@cheapest',
    }
    const runtime = {
        getModel: (provider: string, id: string) =>
            provider === 'provider-a' && id === '@cheapest'
                ? explicit
                : undefined,
        getModels: () => [explicit],
    } as any
    assert.equal(resolvePiModel(runtime, '@cheapest', undefined), explicit)
    assert.throws(
        () => resolvePiModel(runtime, '@capable', undefined),
        /Unknown model/
    )
    assert.equal(resolvePiModel(runtime, undefined, undefined), undefined)
})

test('Pi idle sends do not reuse the explicit initial run id', async () => {
    const backend = createPiBackend({
        sessionFactory: async () =>
            ({
                session: makeMinimalSdkSession(),
            }) as Awaited<ReturnType<PiSessionFactory>>,
    })
    const runIds = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const session = yield* backend.spawn({
                    ...task,
                    agentId: 'sa-1',
                    runId: 'sa-1:run-1',
                })
                const seen = yield* Ref.make<string[]>([])
                const collector = yield* Stream.runForEach(
                    session.events,
                    (event) =>
                        event._tag === 'RunStarted'
                            ? Ref.update(seen, (current) => [
                                  ...current,
                                  event.runId,
                              ])
                            : Effect.void
                ).pipe(Effect.forkScoped)
                yield* session.send('second turn')
                yield* Effect.sleep(Duration.millis(5))
                yield* session.close
                yield* Fiber.join(collector)
                return yield* Ref.get(seen)
            })
        )
    )
    assert.deepEqual(runIds, ['sa-1:run-1', 'sa-1:run-2'])
})

test('role tool sets match their intended capabilities', () => {
    assert.deepEqual(READ_ONLY_TOOL_NAMES, [
        'read',
        'grep',
        'find',
        'ls',
    ])
    assert.ok(REVIEW_TOOL_NAMES.includes('bash'))
    assert.ok(CODING_TOOL_NAMES.includes('edit'))
    assert.ok(CODING_TOOL_NAMES.includes('write'))
})

test('child allowlists exclude custom and orchestration tools', () => {
    const tools = childToolNames(AGENT_ROLES.reviewer, true)
    assert.ok(tools.includes('bash'))
    assert.ok(tools.includes('report_to_parent'))
    assert.equal(tools.includes('edit'), false)
    assert.equal(tools.includes('custom-dangerous-tool'), false)
    for (const excluded of CHILD_EXCLUDED_TOOL_NAMES)
        assert.equal(tools.includes(excluded), false)
})

test('report_to_parent supports blocking questions and capped progress updates', () => {
    assert.match(REPORT_TO_PARENT_TOOL_DESCRIPTION, /genuine blocking question/)
    assert.match(REPORT_TO_PARENT_TOOL_DESCRIPTION, /kind update/)
    assert.match(REPORT_TO_PARENT_TOOL_DESCRIPTION, /max 3 per run/)
    assert.match(
        REPORT_TO_PARENT_TOOL_DESCRIPTION,
        /Do not use question for progress updates/
    )
    assert.match(
        REPORT_TO_PARENT_TOOL_DESCRIPTION,
        /Keep those for your final response/
    )
    assert.match(
        REPORT_TO_PARENT_MESSAGE_DESCRIPTION,
        /concise blocking question/
    )
    assert.match(
        REPORT_TO_PARENT_MESSAGE_DESCRIPTION,
        /why the decision is needed/
    )
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
            'subagent_interrupt',
            'subagent_close',
            'subagent_send',
            'subagent_check',
            'subagent_list',
        ]
    )
})

// --- P00 follow-up dispatch regression matrix ---------------------------------
// The fake SDK below follows the real SDK event sequence: native follow-ups
// would drain inside the same agent loop without a fresh `agent_start`, so the
// backend must never use them for logical runs. Each accepted follow-up gets
// its own top-level `prompt` after the prior run fully settles.

interface FakeSdkControls {
    readonly sdk: AgentSession & {
        promptCalls: string[]
        steerCalls: string[]
        followUpCalls: string[]
        abortCalls: boolean[]
        finishRun: (finalText: string) => void
        failPendingPrompt: (error: unknown) => void
        failNextPreflight: (error: unknown) => void
        openPreflight: () => void
        emitRaw: (event: unknown) => void
    }
}

function makeControllableSdk(options: { gatePreflight?: boolean } = {}) {
    const listeners = new Set<(event: any) => void>()
    const emit = (event: any) => {
        for (const listener of [...listeners]) listener(event)
    }
    let preflightOpen = !options.gatePreflight
    let failPreflightMessage: unknown
    const preflightWaiters: Array<() => void> = []
    let pending:
        | { resolve: () => void; reject: (error: unknown) => void }
        | undefined
    const sdk = makeMinimalSdkSession({
        prompt: async (text: string) => {
            ;(sdk as any).promptCalls.push(text)
            if ((sdk as any).isStreaming)
                throw new Error(
                    'Agent is already processing. Specify streamingBehavior.'
                )
            while (!preflightOpen) {
                await new Promise<void>((resolve) => {
                    preflightWaiters.push(resolve)
                })
            }
            if (failPreflightMessage !== undefined) {
                const error = failPreflightMessage
                failPreflightMessage = undefined
                throw error
            }
            ;(sdk as any).isStreaming = true
            emit({ type: 'agent_start' })
            const userMessage = {
                role: 'user',
                content: [{ type: 'text', text }],
            }
            ;(sdk as any).messages.push(userMessage)
            emit({ type: 'message_start', message: userMessage })
            emit({ type: 'message_end', message: userMessage })
            await new Promise<void>((resolve, reject) => {
                pending = { resolve, reject }
            })
        },
        followUp: async (text: string) => {
            ;(sdk as any).followUpCalls.push(text)
        },
        steer: async (text: string) => {
            ;(sdk as any).steerCalls.push(text)
            emit({ type: 'queue_update', steering: [text], followUp: [] })
        },
        abort: async () => {
            ;(sdk as any).abortCalls.push(true)
            if ((sdk as any).isStreaming) {
                const aborted = {
                    role: 'assistant',
                    content: [{ type: 'text', text: '' }],
                    stopReason: 'aborted',
                    provider: 'p',
                    model: 'm',
                }
                ;(sdk as any).messages.push(aborted)
                emit({ type: 'message_end', message: aborted })
                ;(sdk as any).isStreaming = false
                emit({ type: 'agent_settled' })
                pending?.resolve()
                pending = undefined
            }
        },
        clearQueue: () => {
            emit({ type: 'queue_update', steering: [], followUp: [] })
        },
    }) as any
    sdk.promptCalls = []
    sdk.steerCalls = []
    sdk.followUpCalls = []
    sdk.abortCalls = []
    sdk.finishRun = (finalText: string) => {
        const assistant = {
            role: 'assistant',
            content: [{ type: 'text', text: finalText }],
            stopReason: 'stop',
            provider: 'p',
            model: 'm',
        }
        sdk.messages.push(assistant)
        emit({ type: 'message_end', message: assistant })
        sdk.isStreaming = false
        emit({ type: 'agent_settled' })
        pending?.resolve()
        pending = undefined
    }
    sdk.failPendingPrompt = (error: unknown) => {
        pending?.reject(error)
        pending = undefined
    }
    sdk.openPreflight = () => {
        preflightOpen = true
        while (preflightWaiters.length > 0) preflightWaiters.shift()?.()
    }
    sdk.failNextPreflight = (error: unknown) => {
        failPreflightMessage = error
    }
    sdk.emitRaw = (event: unknown) => emit(event as any)
    return sdk as FakeSdkControls['sdk']
}

async function spawnWithFakeSdk(
    sdk: FakeSdkControls['sdk'],
    spawnTask: SpawnTask = {
        ...task,
        agentId: 'sa-1',
        runId: 'sa-1:run-1',
    },
    cleanupTimeoutMs?: number
) {
    const sessionFactory: PiSessionFactory = (async () => ({
        session: sdk as unknown as AgentSession,
    })) as unknown as PiSessionFactory
    const backend = createPiBackend({
        sessionFactory,
        cleanupTimeoutMs,
    })
    const seen: SubagentEvent[] = []
    const scope = Effect.runSync(Scope.make())
    const session = await Effect.runPromise(
        Scope.provide(
            backend.spawn(spawnTask),
            scope
        ) as Effect.Effect<SubagentSession, SpawnError>
    )
    Effect.runFork(
        Stream.runForEach(session.events, (event) =>
            Effect.sync(() => {
                seen.push(event)
            })
        )
    )
    return { backend, session, seen, scope }
}

async function waitFor(
    predicate: () => boolean,
    label: string,
    timeoutMs = 2_000
) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${label}`)
}

function runIds(seen: SubagentEvent[], tag: 'RunStarted' | 'RunSettled') {
    return seen
        .filter((event) => event._tag === tag)
        .map((event) => (event as { runId: string }).runId)
}

test('P00 queued follow-ups dispatch as separate top-level prompts in order', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(session.send('follow-up one', 'follow-up', 'sa-1:run-2'))
    await Effect.runPromise(session.send('follow-up two', 'follow-up', 'sa-1:run-3'))
    // No native follow-up lifecycle is used for logical runs.
    assert.deepEqual(sdk.followUpCalls, [])
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    sdk.finishRun('first answer')
    await waitFor(() => sdk.promptCalls.length === 2, 'second prompt')
    assert.deepEqual(sdk.promptCalls, ['Initial task', 'follow-up one'])
    sdk.finishRun('second answer')
    await waitFor(() => sdk.promptCalls.length === 3, 'third prompt')
    assert.deepEqual(sdk.promptCalls, [
        'Initial task',
        'follow-up one',
        'follow-up two',
    ])
    sdk.finishRun('third answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 3,
        'three settlements'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), [
        'sa-1:run-1',
        'sa-1:run-2',
        'sa-1:run-3',
    ])
    assert.deepEqual(runIds(seen, 'RunSettled'), [
        'sa-1:run-1',
        'sa-1:run-2',
        'sa-1:run-3',
    ])
    const outcomes = seen
        .filter((event) => event._tag === 'RunSettled')
        .map((event) => (event as Extract<SubagentEvent, { _tag: 'RunSettled' }>).outcome._tag)
    assert.deepEqual(outcomes, ['Completed', 'Completed', 'Completed'])
    await Effect.runPromise(session.close)
})

test('P00 identical follow-up strings are tracked by run ID', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(session.send('same text', 'follow-up', 'sa-1:run-2'))
    await Effect.runPromise(session.send('same text', 'follow-up', 'sa-1:run-3'))
    sdk.finishRun('first')
    await waitFor(() => sdk.promptCalls.length === 2, 'second prompt')
    sdk.finishRun('second')
    await waitFor(() => sdk.promptCalls.length === 3, 'third prompt')
    sdk.finishRun('third')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 3,
        'three settlements'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), [
        'sa-1:run-1',
        'sa-1:run-2',
        'sa-1:run-3',
    ])
    await Effect.runPromise(session.close)
})

test('P00 follow-up during prompt preflight enqueues instead of racing', async () => {
    const sdk = makeControllableSdk({ gatePreflight: true })
    const { session, seen } = await spawnWithFakeSdk(sdk)
    // Initial prompt is stuck in preflight: streaming has not started, but the
    // backend must already report `starting` so a concurrent send enqueues.
    await waitFor(() => sdk.promptCalls.length === 1, 'initial prompt call')
    assert.equal(sdk.isStreaming, false)
    await Effect.runPromise(session.send('preflight follow-up', 'follow-up', 'sa-1:run-2'))
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    sdk.openPreflight()
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    sdk.finishRun('first')
    await waitFor(() => sdk.promptCalls.length === 2, 'queued prompt')
    assert.deepEqual(sdk.promptCalls, ['Initial task', 'preflight follow-up'])
    sdk.finishRun('second')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 2,
        'both settlements'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1', 'sa-1:run-2'])
    await Effect.runPromise(session.close)
})

test('P00 two concurrent sends to an idle child serialize in order', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    sdk.finishRun('first')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'initial settlement'
    )
    await Promise.all([
        Effect.runPromise(session.send('idle A', 'follow-up', 'sa-1:run-2')),
        Effect.runPromise(session.send('idle B', 'follow-up', 'sa-1:run-3')),
    ])
    // Exactly one send wins the synchronous idle reservation; the other queues.
    await waitFor(() => sdk.promptCalls.length === 2, 'first idle prompt')
    assert.deepEqual(sdk.promptCalls.slice(1), ['idle A'])
    sdk.finishRun('second')
    await waitFor(() => sdk.promptCalls.length === 3, 'queued idle prompt')
    assert.deepEqual(sdk.promptCalls.slice(1), ['idle A', 'idle B'])
    sdk.finishRun('third')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 3,
        'all settlements'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), [
        'sa-1:run-1',
        'sa-1:run-2',
        'sa-1:run-3',
    ])
    await Effect.runPromise(session.close)
})

test('P00 steer during a run redirects without a new logical assignment', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(session.send('change direction', 'steer'))
    assert.deepEqual(sdk.steerCalls, ['change direction'])
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    sdk.finishRun('steered answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'single settlement'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    const settled = seen.find((event) => event._tag === 'RunSettled')
    assert.equal(
        (settled as Extract<SubagentEvent, { _tag: 'RunSettled' }>).outcome._tag,
        'Completed'
    )
    await Effect.runPromise(session.close)
})

test('P00 preflight rejection settles the run as failed and dispatches queued work', async () => {
    const sdk = makeControllableSdk({ gatePreflight: true })
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.promptCalls.length === 1, 'initial prompt call')
    // B queues while A is still in prompt preflight (streaming not started).
    await Effect.runPromise(session.send('queued B', 'follow-up', 'sa-1:run-2'))
    assert.equal(sdk.isStreaming, false)
    // A's preflight rejects: no agent lifecycle will ever arrive for it.
    sdk.failNextPreflight(new Error('no auth for provider'))
    sdk.openPreflight()
    await waitFor(
        () =>
            seen.some(
                (event) =>
                    event._tag === 'RunSettled' &&
                    (event as { runId: string }).runId === 'sa-1:run-1'
            ),
        'A settles as failed'
    )
    const first = seen.find(
        (event) =>
            event._tag === 'RunSettled' &&
            (event as { runId: string }).runId === 'sa-1:run-1'
    ) as Extract<SubagentEvent, { _tag: 'RunSettled' }>
    assert.equal(first.outcome._tag, 'Failed')
    await waitFor(() => sdk.promptCalls.length === 2, 'B dispatches')
    assert.deepEqual(sdk.promptCalls, ['Initial task', 'queued B'])
    sdk.finishRun('B answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 2,
        'both settlements'
    )
    const second = seen.find(
        (event) =>
            event._tag === 'RunSettled' &&
            (event as { runId: string }).runId === 'sa-1:run-2'
    ) as Extract<SubagentEvent, { _tag: 'RunSettled' }>
    assert.equal(second.outcome._tag, 'Completed')
    await Effect.runPromise(session.close)
})

test('P00 duplicate settlement and stale run events cannot corrupt runs', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    sdk.finishRun('answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'initial settlement'
    )
    // Duplicate SDK settlement and a stale extra start must not produce
    // additional logical runs.
    sdk.emitRaw({ type: 'agent_settled' })
    sdk.emitRaw({ type: 'agent_start' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(runIds(seen, 'RunSettled'), ['sa-1:run-1'])
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    await Effect.runPromise(session.send('second turn', 'follow-up', 'sa-1:run-2'))
    await waitFor(() => sdk.promptCalls.length === 2, 'second prompt')
    sdk.finishRun('second answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 2,
        'second settlement'
    )
    assert.deepEqual(runIds(seen, 'RunSettled'), ['sa-1:run-1', 'sa-1:run-2'])
    await Effect.runPromise(session.close)
})

test('P00 native retry continuation shares the active logical run', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    // A native retry/compaction continuation emits another agent_start without
    // settling. It must not allocate a new logical run or finish the current one.
    sdk.emitRaw({ type: 'agent_start' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    assert.deepEqual(runIds(seen, 'RunSettled'), [])
    sdk.finishRun('answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'single settlement'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    await Effect.runPromise(session.close)
})

test('P00 queued follow-ups stay visible in QueueChanged with run IDs', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(session.send('queued work', 'follow-up', 'sa-1:run-2'))
    await waitFor(
        () =>
            seen.some(
                (event) =>
                    event._tag === 'QueueChanged' &&
                    (event as Extract<SubagentEvent, { _tag: 'QueueChanged' }>).queued.some(
                        (item) => item.kind === 'follow-up'
                    )
            ),
        'queued follow-up visible'
    )
    const queued = (
        seen.filter(
            (event) => event._tag === 'QueueChanged'
        ) as Extract<SubagentEvent, { _tag: 'QueueChanged' }>[]
    ).at(-1)
    assert.deepEqual(
        queued?.queued.map((item) => [item.kind, item.text]),
        [['follow-up', 'queued work']]
    )
    sdk.finishRun('first')
    await waitFor(() => sdk.promptCalls.length === 2, 'queued dispatch')
    sdk.finishRun('second')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 2,
        'both settlements'
    )
    await Effect.runPromise(session.close)
})

test('P00 interrupt during running settles Interrupted and drops queued work', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(session.send('queued work', 'follow-up', 'sa-1:run-2'))
    await Effect.runPromise(session.interrupt)
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'interrupted settlement'
    )
    const settled = seen.find(
        (event) => event._tag === 'RunSettled'
    ) as Extract<SubagentEvent, { _tag: 'RunSettled' }>
    assert.equal(settled.runId, 'sa-1:run-1')
    assert.equal(settled.outcome._tag, 'Interrupted')
    // The queued assignment never dispatches.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    await Effect.runPromise(session.close)
})

test('P00 interrupt waits for a prompt still in preflight', async () => {
    const sdk = makeControllableSdk({ gatePreflight: true })
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.promptCalls.length === 1, 'initial prompt call')

    let interruptFinished = false
    const interrupt = Effect.runPromise(session.interrupt).then(() => {
        interruptFinished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(interruptFinished, false)

    sdk.openPreflight()
    await waitFor(() => sdk.isStreaming, 'preflight prompt to start')
    await sdk.abort()
    await interrupt
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'preflight interrupt settlement'
    )
    assert.equal(interruptFinished, true)
    assert.deepEqual(runIds(seen, 'RunSettled'), ['sa-1:run-1'])
    assert.equal(
        (seen.find((event) => event._tag === 'RunSettled') as Extract<
            SubagentEvent,
            { _tag: 'RunSettled' }
        >).outcome._tag,
        'Interrupted'
    )
    await Effect.runPromise(session.close)
})

test('P00 close reports incomplete cleanup when preflight cannot be cancelled', async () => {
    const sdk = makeControllableSdk({ gatePreflight: true })
    const { session } = await spawnWithFakeSdk(sdk, undefined, 10)
    await waitFor(() => sdk.promptCalls.length === 1, 'initial prompt call')

    const close = await Effect.runPromise(session.close)
    assert.equal(close.terminal, true)
    assert.equal(close.resourcesReleased, false)
    assert.match(close.error ?? '', /prompt|timed out/i)
    sdk.openPreflight()
    await sdk.abort()
})

test('P00 close during queued state rejects later sends', async () => {
    const sdk = makeControllableSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(session.send('queued work', 'follow-up', 'sa-1:run-2'))
    const closeResult = await Effect.runPromise(session.close)
    assert.equal(closeResult.terminal, true)
    const exit = await Effect.runPromise(
        Effect.flip(session.send('after close'))
    )
    assert.match(exit.message, /closed/)
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
})

// --- P1 dispatch-boundary regression ------------------------------------------
// `agent_settled` can arrive while the top-level `session.prompt()` promise is
// still pending. The next queued run must wait for BOTH settlement AND prompt
// resolution, including idle sends landing in that window. A late callback
// from the prior run must never settle the newer run.

function makeDeferredPromptSdk() {
    const listeners = new Set<(event: any) => void>()
    const emit = (event: any) => {
        for (const listener of [...listeners]) listener(event)
    }
    const resolvers: Array<{
        resolve: () => void
        reject: (error: unknown) => void
    }> = []
    const sdk = makeMinimalSdkSession({
        subscribe: (listener: (event: any) => void) => {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        followUp: async (text: string) => {
            ;(sdk as any).followUpCalls.push(text)
        },
        prompt: async (text: string) => {
            ;(sdk as any).promptCalls.push(text)
            if ((sdk as any).isStreaming)
                throw new Error(
                    'Agent is already processing. Specify streamingBehavior.'
                )
            ;(sdk as any).isStreaming = true
            emit({ type: 'agent_start' })
            const userMessage = {
                role: 'user',
                content: [{ type: 'text', text }],
            }
            ;(sdk as any).messages.push(userMessage)
            emit({ type: 'message_start', message: userMessage })
            emit({ type: 'message_end', message: userMessage })
            await new Promise<void>((resolve, reject) => {
                resolvers.push({ resolve, reject })
            })
        },
    }) as any
    sdk.promptCalls = [] as string[]
    sdk.followUpCalls = [] as string[]
    sdk.settleCurrentRun = (finalText: string) => {
        const assistant = {
            role: 'assistant',
            content: [{ type: 'text', text: finalText }],
            stopReason: 'stop',
            provider: 'p',
            model: 'm',
        }
        sdk.messages.push(assistant)
        emit({ type: 'message_end', message: assistant })
        sdk.isStreaming = false
        // Deliberately do NOT resolve the pending prompt promise here. The
        // test resolves or rejects it explicitly to model the
        // post-settlement / pre-resolution window.
        emit({ type: 'agent_settled' })
    }
    sdk.resolveCurrentPrompt = () => {
        resolvers.shift()?.resolve()
    }
    sdk.failCurrentPrompt = (error: unknown) => {
        resolvers.shift()?.reject(error)
    }
    sdk.emitRaw = (event: unknown) => emit(event as any)
    return sdk as FakeSdkControls['sdk'] & {
        settleCurrentRun: (finalText: string) => void
        resolveCurrentPrompt: () => void
        failCurrentPrompt: (error: unknown) => void
    }
}

function settledById(seen: SubagentEvent[], runId: string) {
    return seen.find(
        (event) => event._tag === 'RunSettled' && event.runId === runId
    ) as Extract<SubagentEvent, { _tag: 'RunSettled' }> | undefined
}

test('P1 post-settlement prompt promise blocks next dispatch until resolved', async () => {
    const sdk = makeDeferredPromptSdk()
    const { session, seen } = await spawnWithFakeSdk(sdk)
    await waitFor(() => sdk.promptCalls.length === 1, 'initial prompt')
    await waitFor(() => sdk.isStreaming, 'initial run to start')
    await Effect.runPromise(
        session.send('follow-up B', 'follow-up', 'sa-1:run-2')
    )
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    // Settle A's SDK run while A's prompt promise stays deferred.
    sdk.settleCurrentRun('first answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 1,
        'A settles'
    )
    assert.deepEqual(runIds(seen, 'RunSettled'), ['sa-1:run-1'])
    assert.equal(settledById(seen, 'sa-1:run-1')?.outcome._tag, 'Completed')
    // B must not dispatch while A's prompt promise is still pending.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    // An idle send landing in the post-settlement/pre-resolution window
    // must queue rather than dispatch overlapping work.
    await Effect.runPromise(
        session.send('follow-up C', 'follow-up', 'sa-1:run-3')
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(sdk.promptCalls, ['Initial task'])
    assert.deepEqual(runIds(seen, 'RunStarted'), ['sa-1:run-1'])
    // Resolving A's prompt drains exactly one queued run with the right ID.
    sdk.resolveCurrentPrompt()
    await waitFor(() => sdk.promptCalls.length === 2, 'B dispatches')
    assert.deepEqual(sdk.promptCalls, ['Initial task', 'follow-up B'])
    await waitFor(
        () => runIds(seen, 'RunStarted').length === 2,
        'B starts'
    )
    assert.deepEqual(runIds(seen, 'RunStarted'), [
        'sa-1:run-1',
        'sa-1:run-2',
    ])
    // A's late resolution must not settle B early.
    assert.deepEqual(runIds(seen, 'RunSettled'), ['sa-1:run-1'])
    // Settle B, then deliver a stale late failure for B's already-settled
    // prompt. It must not flip B to Failed nor block C.
    sdk.settleCurrentRun('second answer')
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 2,
        'B settles'
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(sdk.promptCalls, ['Initial task', 'follow-up B'])
    sdk.failCurrentPrompt(new Error('late stale prompt noise'))
    await waitFor(() => sdk.promptCalls.length === 3, 'C dispatches')
    assert.deepEqual(sdk.promptCalls, [
        'Initial task',
        'follow-up B',
        'follow-up C',
    ])
    assert.deepEqual(runIds(seen, 'RunStarted'), [
        'sa-1:run-1',
        'sa-1:run-2',
        'sa-1:run-3',
    ])
    const settledB = settledById(seen, 'sa-1:run-2')
    assert.equal(settledB?.outcome._tag, 'Completed')
    assert.equal(
        (settledB?.outcome as { finalText?: string }).finalText,
        'second answer'
    )
    const settledA = settledById(seen, 'sa-1:run-1')
    assert.equal(
        (settledA?.outcome as { finalText?: string }).finalText,
        'first answer'
    )
    // Finish C normally with correct attribution.
    await waitFor(() => sdk.isStreaming, 'C streaming')
    sdk.settleCurrentRun('third answer')
    sdk.resolveCurrentPrompt()
    await waitFor(
        () => runIds(seen, 'RunSettled').length === 3,
        'C settles'
    )
    assert.deepEqual(runIds(seen, 'RunSettled'), [
        'sa-1:run-1',
        'sa-1:run-2',
        'sa-1:run-3',
    ])
    assert.equal(
        (settledById(seen, 'sa-1:run-3')?.outcome as { finalText?: string })
            .finalText,
        'third answer'
    )
    assert.deepEqual(sdk.followUpCalls, [])
    await Effect.runPromise(session.close)
})
