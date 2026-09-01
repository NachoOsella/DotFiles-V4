import assert from 'node:assert/strict'
import test from 'node:test'
import { Duration, Effect, Fiber, Ref, Stream } from 'effect'
import {
    CHILD_EXCLUDED_TOOL_NAMES,
    childToolNames,
    createPiBackend,
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
                assert.deepEqual(capturedOptions?.tools, [...REVIEW_TOOL_NAMES])
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
    assert.equal(
        resolvePiModel(runtime, '@cheapest', undefined),
        explicit
    )
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
        'lsp',
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
