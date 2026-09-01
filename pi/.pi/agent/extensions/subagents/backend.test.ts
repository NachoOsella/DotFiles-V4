import assert from 'node:assert/strict'
import test from 'node:test'
import { Duration, Effect, Ref, Stream } from 'effect'
import {
    CHILD_EXCLUDED_TOOL_NAMES,
    childToolNames,
    createPiBackend,
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
        getAllTools: () => [],
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
                })
                assert.deepEqual(capturedOptions?.tools, [...REVIEW_TOOL_NAMES])
                assert.ok(
                    capturedOptions?.excludeTools?.includes('subagent_spawn')
                )
                assert.deepEqual(activeTools, capturedOptions?.tools)
                yield* session.interrupt
                assert.equal(abortCalled, true)
            })
        )
    )
    assert.equal(disposed, true)
    assert.equal(listeners.size, 0)
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
