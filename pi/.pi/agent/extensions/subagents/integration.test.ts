import assert from 'node:assert/strict'
import test from 'node:test'
import { Cause, Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
    BackendRegistry,
    type SubagentBackend,
    type SubagentSession,
} from './src/backend.ts'
import { makeStubBackend } from './src/backends/stub.ts'
import { createSubagentsExtension } from './index.ts'
import type { BackendName, SubagentEvent } from './src/domain.ts'
import { SubagentManager } from './src/manager.ts'
import { makeSubagentManagerLayer } from './src/manager.ts'
import type { SubagentConfig } from './src/config.ts'

interface TestTool {
    readonly name: string
    readonly execute: (...args: any[]) => Promise<any>
}

type TestHandler = (...args: any[]) => unknown

function createRuntime(cadenceMs = 30) {
    const backend = makeStubBackend({
        backend: 'pi',
        defaultModelLabel: 'pi/integration-test',
        contextWindow: 128_000,
        toolName: 'bash',
        cadenceMs,
    })
    const registry = Layer.sync(
        BackendRegistry,
        () => new Map<BackendName, SubagentBackend>([['pi', backend]])
    )
    const config: SubagentConfig = {
        maxRunning: 8,
        maxTracked: 64,
        roleModels: {},
        roleReasoningEfforts: {},
    }
    return ManagedRuntime.make(
        makeSubagentManagerLayer(config).pipe(Layer.provide(registry))
    )
}

function createQuestionRuntime() {
    const questions = new Map<string, () => void>()
    const backend: SubagentBackend = {
        name: 'pi',
        capabilities: {
            steering: true,
            modelSelection: false,
            reasoningEffort: false,
        },
        available: Effect.succeed(true),
        spawn: (task) =>
            Effect.gen(function* () {
                const events = yield* Queue.make<SubagentEvent, Cause.Done>()
                const agentId = task.agentId ?? 'question-test'
                const runId = task.runId ?? `${agentId}:run-1`
                questions.set(agentId, () =>
                    task.reportToParent?.('Which API should I use?')
                )
                yield* Queue.offer(events, {
                    _tag: 'MetaChanged',
                    meta: { backend: 'pi', modelLabel: 'question-test' },
                })
                yield* Queue.offer(events, { _tag: 'RunStarted', runId })
                return {
                    meta: Effect.succeed({
                        backend: 'pi',
                        modelLabel: 'question-test',
                    }),
                    events: Stream.fromQueue(events),
                    send: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.end(events).pipe(
                        Effect.as({
                            terminal: true,
                            resourcesReleased: true,
                        } as const)
                    ),
                } satisfies SubagentSession
            }),
    }
    const registry = Layer.sync(
        BackendRegistry,
        () => new Map<BackendName, SubagentBackend>([['pi', backend]])
    )
    const config: SubagentConfig = {
        maxRunning: 8,
        maxTracked: 64,
        roleModels: {},
        roleReasoningEfforts: {},
    }
    return {
        runtime: ManagedRuntime.make(
            makeSubagentManagerLayer(config).pipe(Layer.provide(registry))
        ),
        ask(id: string) {
            const ask = questions.get(id)
            if (!ask) throw new Error(`question session was not spawned: ${id}`)
            ask()
        },
    }
}

function createHost() {
    const tools = new Map<string, TestTool>()
    const hooks = new Map<string, TestHandler[]>()
    const messages: Array<{ message: unknown; options: unknown }> = []
    let deliveryFailures = 0
    let sendAttempts = 0

    const pi = {
        on(event: string, handler: TestHandler) {
            const current = hooks.get(event) ?? []
            current.push(handler)
            hooks.set(event, current)
        },
        registerTool(tool: TestTool) {
            tools.set(tool.name, tool)
        },
        registerCommand() {},
        registerMessageRenderer() {},
        getThinkingLevel: () => 'medium',
        sendMessage(message: unknown, options: unknown) {
            sendAttempts++
            if (deliveryFailures > 0) {
                deliveryFailures--
                throw new Error('host rejected subagent message')
            }
            messages.push({ message, options })
        },
    } as unknown as ExtensionAPI

    return {
        pi,
        tools,
        hooks,
        messages,
        get deliveryFailures() {
            return deliveryFailures
        },
        set deliveryFailures(value: number) {
            deliveryFailures = value
        },
        get sendAttempts() {
            return sendAttempts
        },
        async fire(event: string, ...args: unknown[]) {
            for (const handler of hooks.get(event) ?? []) await handler(...args)
        },
    }
}

const context = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => undefined },
    isProjectTrusted: () => false,
    model: undefined,
    modelRegistry: undefined,
}

async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 2_000
) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('integration condition was not reached in time')
}

async function closeHost(host: ReturnType<typeof createHost>) {
    await host.fire('session_shutdown')
}

test('extension hooks deliver completed child results through the host', async () => {
    const runtime = createRuntime()
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    assert.equal(host.hooks.get('session_start')?.length, 1)
    assert.equal(host.hooks.get('session_shutdown')?.length, 1)
    await host.fire('session_start', {}, { hasUI: false })

    try {
        const spawn = host.tools.get('subagent_spawn')
        assert.ok(spawn)
        const result = await spawn.execute(
            'spawn-1',
            {
                name: 'integration child',
                prompt: 'Finish integration delivery',
            },
            undefined,
            undefined,
            context
        )
        assert.equal(result.details.id.startsWith('sa-'), true)

        await waitUntil(() => host.messages.length === 1)
        const delivered = host.messages[0]
        assert.deepEqual(delivered.options, {
            deliverAs: 'followUp',
            triggerTurn: true,
        })
        const message = delivered.message as {
            customType: string
            details: { events: ReadonlyArray<{ kind: string }> }
        }
        assert.equal(message.customType, 'subagent-result')
        assert.equal(message.details.events[0]?.kind, 'result')
        const manager = await runtime.runPromise(SubagentManager)
        assert.equal(manager.peekMailbox().length, 0)
    } finally {
        await closeHost(host)
    }
})

test('host delivery failures are retried before mailbox acknowledgement', async () => {
    const runtime = createRuntime()
    const host = createHost()
    host.deliveryFailures = 1
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })

    try {
        const spawn = host.tools.get('subagent_spawn')
        assert.ok(spawn)
        await spawn.execute(
            'spawn-2',
            { name: 'retry child', prompt: 'Finish retry delivery' },
            undefined,
            undefined,
            context
        )

        const manager = await runtime.runPromise(SubagentManager)
        await waitUntil(
            () =>
                host.sendAttempts >= 2 &&
                host.messages.length === 1 &&
                manager.peekMailbox().length === 0
        )
        assert.equal(host.sendAttempts, 2)
    } finally {
        await closeHost(host)
    }
})

test('new mailbox events preempt a long delivery retry timer', async () => {
    const runtime = createRuntime(1)
    const host = createHost()
    host.deliveryFailures = 1
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })

    try {
        const spawn = host.tools.get('subagent_spawn')
        assert.ok(spawn)
        await spawn.execute(
            'spawn-retry-1',
            {
                name: 'retry timer first',
                prompt: 'Finish first retry timer task',
            },
            undefined,
            undefined,
            context
        )
        const manager = await runtime.runPromise(SubagentManager)
        await waitUntil(
            () => host.sendAttempts >= 1 && manager.peekMailbox().length === 1
        )

        const secondStartedAt = Date.now()
        await spawn.execute(
            'spawn-retry-2',
            {
                name: 'retry timer second',
                prompt: 'Finish second retry timer task',
            },
            undefined,
            undefined,
            context
        )
        await waitUntil(
            () => host.sendAttempts >= 2 && host.messages.length === 1,
            180
        )
        assert.ok(Date.now() - secondStartedAt < 180)
    } finally {
        await closeHost(host)
    }
})

test('question-woken waits return concise output and complete details', async () => {
    const { runtime, ask } = createQuestionRuntime()
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })

    try {
        const spawn = host.tools.get('subagent_spawn')
        const wait = host.tools.get('subagent_wait')
        assert.ok(spawn)
        assert.ok(wait)
        const spawned = await spawn.execute(
            'spawn-question-output',
            { name: 'question child', prompt: 'Ask the parent a question' },
            undefined,
            undefined,
            context
        )
        const id = spawned.details.id as string
        const waiting = wait.execute(
            'wait-question-output',
            { ids: [id] },
            undefined,
            undefined,
            context
        )
        await new Promise((resolve) => setImmediate(resolve))
        ask(id)

        const result = await waiting
        const text = result.content[0]?.text as string
        assert.match(text, new RegExp(`^Subagent question:`))
        assert.match(text, /Answer the question through subagent_send/)
        assert.match(
            text,
            new RegExp(
                `- ${id} question-child \\(default\\) asked: Which API should I use\\?`
            )
        )
        assert.match(text, new RegExp(`Still running: ${id}$`, 'm'))
        assert.doesNotMatch(text, /^## /m)
        assert.deepEqual(Object.keys(result.details).sort(), [
            'completed',
            'events',
            'next_sequence',
            'pending',
            'results',
            'timed_out',
        ])
        assert.deepEqual(result.details.pending, [id])
        assert.deepEqual(result.details.completed, [])
        assert.equal(result.details.timed_out, false)
        assert.equal(result.details.events[0]?.kind, 'question')
        assert.equal(result.details.next_sequence, 1)
        assert.equal(result.details.results[0]?.status, 'running')
    } finally {
        await closeHost(host)
    }
})

test('settled ID waits preserve detailed result output', async () => {
    const runtime = createRuntime(1)
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })

    try {
        const spawn = host.tools.get('subagent_spawn')
        const wait = host.tools.get('subagent_wait')
        assert.ok(spawn)
        assert.ok(wait)
        const spawned = await spawn.execute(
            'spawn-settled-output',
            { name: 'settled child', prompt: 'Finish a normal result' },
            undefined,
            undefined,
            context
        )
        const id = spawned.details.id as string
        const result = await wait.execute(
            'wait-settled-output',
            { ids: [id] },
            undefined,
            undefined,
            context
        )
        const text = result.content[0]?.text as string
        assert.match(text, new RegExp(`^## ${id} settled-child \\(default\\)`))
        assert.doesNotMatch(text, /Still running:/)
        assert.deepEqual(result.details.pending, [])
        assert.deepEqual(result.details.completed, [id])
        assert.equal(result.details.timed_out, false)
        assert.equal(result.details.events[0]?.kind, 'result')
    } finally {
        await closeHost(host)
    }
})

test('wait wakes on interruption and close makes the child permanently unusable', async () => {
    const runtime = createRuntime(50)
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })

    try {
        const spawn = host.tools.get('subagent_spawn')
        const wait = host.tools.get('subagent_wait')
        const interrupt = host.tools.get('subagent_interrupt')
        const close = host.tools.get('subagent_close')
        assert.ok(spawn && wait && interrupt && close)
        const spawned = await spawn.execute(
            'spawn-3',
            { name: 'race child', prompt: 'Stay active for the race' },
            undefined,
            undefined,
            context
        )

        const waiting = wait.execute('wait-1', { ids: [spawned.details.id] })
        await new Promise((resolve) => setTimeout(resolve, 10))
        await interrupt.execute('interrupt-1', { ids: [spawned.details.id] })
        const waitResult = await waiting
        assert.deepEqual(waitResult.details.pending, [])
        assert.deepEqual(waitResult.details.completed, [spawned.details.id])

        const closeResult = await close.execute('close-1', {
            ids: [spawned.details.id],
        })
        assert.equal(closeResult.details.results[0].closed, true)
        const send = host.tools.get('subagent_send')
        assert.ok(send)
        await assert.rejects(
            send.execute(
                'send-1',
                { id: spawned.details.id, message: 'stale message' },
                undefined,
                undefined,
                context
            ),
            /closed/
        )
    } finally {
        await closeHost(host)
    }
})

// --- P00 follow-up dispatch through the real backend and manager ---------------
// The fake SDK follows the installed SDK event sequence. Queued follow-ups must
// run as separate top-level prompts; the manager must not report `done` while
// a follow-up is still pending, and ID waits must receive the final output.

function makeP00Sdk() {
    const listeners = new Set<(event: any) => void>()
    const emit = (event: any) => {
        for (const listener of [...listeners]) listener(event)
    }
    let pending: { resolve: () => void } | undefined
    const sdk: any = {
        messages: [],
        thinkingLevel: 'medium',
        sessionFile: undefined,
        model: undefined,
        isStreaming: false,
        promptCalls: [] as string[],
        followUpCalls: [] as string[],
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
        prompt: async (text: string) => {
            sdk.promptCalls.push(text)
            if (sdk.isStreaming) throw new Error('Agent is already processing')
            sdk.isStreaming = true
            emit({ type: 'agent_start' })
            const userMessage = {
                role: 'user',
                content: [{ type: 'text', text }],
            }
            sdk.messages.push(userMessage)
            emit({ type: 'message_start', message: userMessage })
            emit({ type: 'message_end', message: userMessage })
            await new Promise<void>((resolve) => {
                pending = { resolve }
            })
        },
        followUp: async (text: string) => {
            sdk.followUpCalls.push(text)
        },
        steer: async () => undefined,
        finishRun: (finalText: string) => {
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
        },
    }
    return sdk
}

async function waitForP00(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`P00 condition not reached: ${label}`)
}

test('P00 follow-up settles through a second prompt without stranding the wait', async () => {
    const sdk = makeP00Sdk()
    const { createPiBackend: makeBackend } =
        await import('./src/backends/pi.ts')
    const backend = makeBackend({
        sessionFactory: (async () => ({ session: sdk })) as never,
    })
    const registry = Layer.sync(
        BackendRegistry,
        () => new Map<BackendName, SubagentBackend>([['pi', backend]])
    )
    const config: SubagentConfig = {
        maxRunning: 8,
        maxTracked: 64,
        roleModels: {},
        roleReasoningEfforts: {},
    }
    const runtime = ManagedRuntime.make(
        makeSubagentManagerLayer(config).pipe(Layer.provide(registry))
    )
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    await host.fire('session_start', {}, { hasUI: false })

    try {
        const spawn = host.tools.get('subagent_spawn')
        const send = host.tools.get('subagent_send')
        const wait = host.tools.get('subagent_wait')
        assert.ok(spawn && send && wait)
        const spawned = await spawn.execute(
            'spawn-p00',
            { name: 'p00 child', prompt: 'initial work' },
            undefined,
            undefined,
            context
        )
        const id = spawned.details.id as string
        await waitForP00(() => sdk.isStreaming, 'initial run streaming')
        await send.execute(
            'send-p00',
            { id, message: 'follow-up work' },
            undefined,
            undefined,
            context
        )
        assert.deepEqual(sdk.followUpCalls, [])
        sdk.finishRun('first answer')
        await waitForP00(() => sdk.promptCalls.length === 2, 'second prompt')
        assert.deepEqual(sdk.promptCalls, ['initial work', 'follow-up work'])
        sdk.finishRun('second answer')

        const result = await wait.execute(
            'wait-p00',
            { ids: [id] },
            undefined,
            undefined,
            context
        )
        assert.deepEqual(result.details.pending, [])
        assert.deepEqual(result.details.completed, [id])
        assert.equal(result.details.timed_out, false)
        assert.match(result.content[0]?.text as string, /second answer/)

        // Exactly one delivered final result per logical run.
        await waitForP00(
            () =>
                host.messages.flatMap((entry) =>
                    (
                        (
                            entry.message as {
                                details?: {
                                    events?: Array<{
                                        kind: string
                                        runId: string
                                    }>
                                }
                            }
                        ).details?.events ?? []
                    ).filter((event) => event.kind === 'result')
                ).length +
                    (
                        result.details.events as Array<{
                            kind: string
                            runId: string
                        }>
                    ).filter((event) => event.kind === 'result').length >=
                2,
            'both run results delivered'
        )
        const deliveredRunIds = [
            ...host.messages.flatMap((entry) =>
                (
                    (
                        entry.message as {
                            details?: {
                                events?: Array<{ kind: string; runId: string }>
                            }
                        }
                    ).details?.events ?? []
                )
                    .filter((event) => event.kind === 'result')
                    .map((event) => event.runId)
            ),
            ...(result.details.events as Array<{ kind: string; runId: string }>)
                .filter((event) => event.kind === 'result')
                .map((event) => event.runId),
        ]
        assert.equal(new Set(deliveredRunIds).size, 2)
    } finally {
        await closeHost(host)
    }
})

test('P01 multi-child wait stays within budget with manifest and omission routes', async () => {
    const runtime = createRuntime(1)
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    await host.fire('session_start', {}, { hasUI: false })
    try {
        const spawn = host.tools.get('subagent_wait')
        const spawner = host.tools.get('subagent_spawn')
        const waiter = host.tools.get('subagent_wait')
        assert.ok(spawner && waiter && spawn)
        const ids: string[] = []
        for (let index = 0; index < 6; index++) {
            const spawned = await spawner.execute(
                `spawn-budget-${index}`,
                {
                    name: `budget child ${index}`,
                    prompt: `Budget work ${index} ${'x'.repeat(7_000)}`,
                },
                undefined,
                undefined,
                context
            )
            ids.push(spawned.details.id as string)
        }
        const result = await waiter.execute(
            'wait-budget',
            { ids },
            undefined,
            undefined,
            context
        )
        const text = result.content[0]?.text as string
        const bytes = Buffer.byteLength(text, 'utf8')
        assert.ok(
            bytes <= 32 * 1024,
            `wait output exceeds 32 KiB budget: ${bytes}`
        )
        // All requested IDs appear in the model-visible manifest and details.
        assert.match(text, /Requested 6 subagent/)
        for (const id of ids) assert.match(text, new RegExp(id))
        assert.equal(result.details.results.length, 6)
        // When bodies are omitted to fit, every omitted child names a usable
        // retrieval route (session transcript) rather than an invented file.
        if (text.includes('Omitted')) {
            assert.match(text, /Omitted \d+ of 6/)
            assert.match(
                text,
                /session transcript|no transcript file available/
            )
        }
        // Never present a displayed subset as complete: omitted IDs are only
        // in details when an omission notice is also visible.
        const displayed = new Set(
            [...text.matchAll(/(sa-\d+)/g)].map((match) => match[1])
        )
        const missing = ids.filter((id) => !displayed.has(id))
        if (missing.length > 0) assert.match(text, /Omitted/)
    } finally {
        await closeHost(host)
    }
})

test('P01 mailbox wait without IDs stays within the aggregate byte budget', async () => {
    const runtime = createRuntime(1)
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    await host.fire('session_start', {}, { hasUI: false })
    try {
        const manager = await runtime.runPromise(SubagentManager)
        for (let index = 0; index < 6; index++) {
            manager.mailbox.publish({
                agentId: `sa-budget-${index}`,
                taskName: 'budget',
                role: 'worker',
                kind: 'result',
                text: 'y'.repeat(8 * 1024),
            })
        }
        const wait = host.tools.get('subagent_wait')
        assert.ok(wait)
        const result = await wait.execute(
            'wait-mailbox-budget',
            {},
            undefined,
            undefined,
            context
        )
        const text = result.content[0]?.text as string
        const bytes = Buffer.byteLength(text, 'utf8')
        assert.ok(bytes <= 32 * 1024, `mailbox output exceeds budget: ${bytes}`)
        // Full events remain in details while displayed text carries an
        // explicit truncation notice instead of a silent subset.
        assert.equal(result.details.events.length, 6)
        assert.match(text, /\[Output truncated/)
    } finally {
        await closeHost(host)
    }
})

test('P01 explicit wait cancellation leaves child work running', async () => {
    const runtime = createRuntime(50)
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    await host.fire('session_start', {}, { hasUI: false })
    try {
        const spawn = host.tools.get('subagent_spawn')
        const wait = host.tools.get('subagent_wait')
        assert.ok(spawn && wait)
        const spawned = await spawn.execute(
            'spawn-cancel',
            { name: 'cancel child', prompt: 'Stay active for cancellation' },
            undefined,
            undefined,
            context
        )
        const id = spawned.details.id as string
        const controller = new AbortController()
        const waiting = wait.execute(
            'wait-cancel',
            { ids: [id] },
            controller.signal,
            undefined,
            context
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.abort()
        await assert.rejects(waiting, /Wait aborted\. Subagents keep running/)
        const manager = await runtime.runPromise(SubagentManager)
        assert.equal(manager.view.get(id)?.status, 'running')
        await runtime.runPromise(manager.interrupt([id]))
    } finally {
        await closeHost(host)
    }
})

test('P01 ID waits filter by after_sequence without losing retained events', async () => {
    const { runtime, ask } = createQuestionRuntime()
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    await host.fire('session_start', {}, { hasUI: false })
    try {
        const spawn = host.tools.get('subagent_spawn')
        const wait = host.tools.get('subagent_wait')
        assert.ok(spawn && wait)
        const first = await spawn.execute(
            'spawn-cursor-a',
            { name: 'cursor a', prompt: 'Ask A' },
            undefined,
            undefined,
            context
        )
        const second = await spawn.execute(
            'spawn-cursor-b',
            { name: 'cursor b', prompt: 'Ask B' },
            undefined,
            undefined,
            context
        )
        const idA = first.details.id as string
        const idB = second.details.id as string
        const manager = await runtime.runPromise(SubagentManager)
        // Disable automatic parent delivery for this cursor unit: direct
        // mailbox publishes would otherwise race a global claim against the
        // filtered wait. This isolates cursor filtering/retention.
        manager.setOnMailbox(undefined)
        // Direct mailbox publishes avoid automatic-delivery races and give a
        // deterministic global order: A seq1, B seq2.
        const publishedA1 = manager.mailbox.publish({
            agentId: idA,
            taskName: 'cursor-a',
            role: 'default',
            kind: 'question',
            text: 'Q1 for A',
        })
        const publishedB = manager.mailbox.publish({
            agentId: idB,
            taskName: 'cursor-b',
            role: 'default',
            kind: 'question',
            text: 'Q2 for B',
        })
        assert.ok(publishedA1 && publishedB)
        assert.ok(publishedA1.sequence < publishedB.sequence)
        // Consume only B; A stays retained with the earlier sequence.
        const consumedB = await wait.execute(
            'wait-cursor-b',
            { ids: [idB] },
            undefined,
            undefined,
            context
        )
        assert.equal(consumedB.details.events.length, 1)
        assert.equal(manager.peekMailbox({ agentIds: [idA] }).length, 1)
        const pastCursor = publishedB.sequence
        // A global cursor past the retained earlier question filters it but
        // retains it instead of losing it; newly queued questions still wake.
        const waiting = wait.execute(
            'wait-cursor-a-filtered',
            { ids: [idA], after_sequence: pastCursor },
            undefined,
            undefined,
            context
        )
        await new Promise((resolve) => setImmediate(resolve))
        // Publish through the manager-owned path so the pending ID wait wakes
        // via manager change notification (direct mailbox.publish would not
        // notify manager.waitFor).
        ask(idA)
        const filtered = await waiting
        assert.equal(filtered.details.events.length, 1)
        assert.ok(
            (filtered.details.events[0]?.sequence as number) > pastCursor,
            'filtered wait must return only sequences past the cursor'
        )
        // The earlier retained question was not silently skipped: it is still
        // peekable and the returned cursor stays conservative.
        assert.equal(manager.peekMailbox({ agentIds: [idA] }).length, 1)
        const next = filtered.details.next_sequence as number
        assert.ok(
            next <= pastCursor ||
                next < (filtered.details.events[0]?.sequence as number),
            `conservative cursor must not skip retained seq1 (next=${next})`
        )
        // after_sequence 0 returns retained history without filtering.
        const all = await wait.execute(
            'wait-cursor-a-all',
            { ids: [idA], after_sequence: 0 },
            undefined,
            undefined,
            context
        )
        assert.ok(all.details.events.length >= 1)
    } finally {
        await closeHost(host)
    }
})

test('P00 ID-wait ownership suppresses automatic delivery during settlement', async () => {
    const sdk = makeP00Sdk()
    const { createPiBackend: makeBackend } =
        await import('./src/backends/pi.ts')
    const backend = makeBackend({
        sessionFactory: (async () => ({ session: sdk })) as never,
    })
    const registry = Layer.sync(
        BackendRegistry,
        () => new Map<BackendName, SubagentBackend>([['pi', backend]])
    )
    const config: SubagentConfig = {
        maxRunning: 8,
        maxTracked: 64,
        roleModels: {},
        roleReasoningEfforts: {},
    }
    const runtime = ManagedRuntime.make(
        makeSubagentManagerLayer(config).pipe(Layer.provide(registry))
    )
    const host = createHost()
    createSubagentsExtension(host.pi, { createRuntime: () => runtime })
    await host.fire('session_start', {}, { hasUI: false })

    try {
        const spawn = host.tools.get('subagent_spawn')
        const wait = host.tools.get('subagent_wait')
        assert.ok(spawn && wait)
        const spawned = await spawn.execute(
            'spawn-p00-wait',
            { name: 'p00 wait child', prompt: 'owned work' },
            undefined,
            undefined,
            context
        )
        const id = spawned.details.id as string
        await waitForP00(() => sdk.isStreaming, 'run streaming')
        const waiting = wait.execute(
            'wait-p00-owned',
            { ids: [id] },
            undefined,
            undefined,
            context
        )
        // Let the wait register ownership before the run settles.
        await new Promise((resolve) => setTimeout(resolve, 50))
        sdk.finishRun('owned answer')
        const result = await waiting
        assert.deepEqual(result.details.pending, [])
        assert.deepEqual(result.details.completed, [id])
        assert.equal(result.details.events[0]?.kind, 'result')
        // The owned result goes to the waiter, not to automatic delivery, and
        // nothing remains permanently hidden in the mailbox.
        assert.equal(host.messages.length, 0)
        const manager = await runtime.runPromise(SubagentManager)
        assert.equal(manager.peekMailbox({ agentIds: [id] }).length, 0)
    } finally {
        await closeHost(host)
    }
})
