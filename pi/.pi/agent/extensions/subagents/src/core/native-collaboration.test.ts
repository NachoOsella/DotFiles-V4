import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'
import { SessionFactory } from './session-factory.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import { SubagentCoordinator } from './coordinator.ts'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import type { InterAgentCommunication } from '../domain/communication.ts'
import type { AgentPath } from '../domain/ids.ts'

/**
 * Offline reproduction of an autonomous child-extension turn.
 *
 * A child session loads the host's extensions. `background-terminals`
 * delivers a finished terminal with
 * `pi.sendMessage({ ... }, { deliverAs: 'followUp', triggerTurn: true })`,
 * and `pi.on('agent_settled', flushResults)` flushes deferred terminal
 * results from the settling boundary. When the child is idle the SDK's
 * `sendCustomMessage` starts an agent run through `_runAgentPrompt`. The
 * subagents coordinator only tracks runs it starts itself through
 * `startRun`, so this run is invisible to it.
 *
 * All streams are simulated in-process; no provider is contacted. Public
 * `agent_start` arrives asynchronously, so assertions that read coordinator
 * state synchronize on an observed event or a held stream.
 */

const MODEL: Model<'test-api'> = {
    id: 'test-model',
    name: 'Test model',
    api: 'test-api',
    provider: 'test-provider',
    baseUrl: 'http://test.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
}

const WORKER = '/root/worker' as AgentPath

function usage(input: number, output: number) {
    return {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
}

function assistantMessage(
    text: string,
    input: number,
    output: number
): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: usage(input, output),
        stopReason: 'stop',
        timestamp: Date.now(),
    }
}

function abortedMessage(): AssistantMessage {
    return {
        role: 'assistant',
        content: [],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: usage(0, 0),
        stopReason: 'aborted',
        timestamp: Date.now(),
    }
}

/** Resolve on the next observed session event of `type`. */
function waitForEvent(session: AgentSession, type: string): Promise<void> {
    return new Promise((resolve) => {
        const unsubscribe = session.subscribe((event) => {
            if (event.type === type) {
                unsubscribe()
                resolve()
            }
        })
    })
}

/** Let queued observer work (settlement delivery) run. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

async function createDirectory(t: TestContext): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'subagents-native-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    return directory
}

interface ChildHarness {
    readonly runtime: AgentRuntime
    readonly session: AgentSession
    readonly pi: ExtensionAPI
    readonly lifecycle: string[]
    /** True when the AbortSignal was already aborted at stream request time. */
    readonly streamStarts: boolean[]
    /** Custom messages the SDK delivered, as serialized content. */
    readonly sent: string[]
    setResponse(text: string, input?: number, output?: number): void
    holdNextResponse(): void
    releaseHeldResponse(): void
    /** Resolves after the next provider stream request is observed. */
    nextStreamStart(): Promise<void>
    resetLifecycle(): void
}

interface ChildOptions {
    /** Register a real `pi.on('agent_settled')` wake like background-terminals. */
    readonly wakeOnSettled?: string
}

/** A real SDK child whose stream is fully simulated. */
async function createChild(
    directory: string,
    path: AgentPath,
    options: ChildOptions = {}
): Promise<ChildHarness> {
    const captured: { pi?: ExtensionAPI } = {}
    let wakeSent = false
    const wakeOnSettled = options.wakeOnSettled
    const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
    })
    const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noThemes: true,
        extensionFactories: [
            (pi) => {
                captured.pi = pi
                if (wakeOnSettled !== undefined) {
                    // The real background-terminals shape: flush a finished
                    // terminal from the extension agent_settled handler.
                    pi.on('agent_settled', () => {
                        if (wakeSent) return
                        wakeSent = true
                        pi.sendMessage(
                            {
                                customType: 'background-terminal-result',
                                content: wakeOnSettled,
                                display: true,
                                details: {},
                            },
                            { deliverAs: 'followUp', triggerTurn: true }
                        )
                    })
                }
            },
        ],
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(directory),
        model: MODEL,
        modelRuntime: {
            getAuth: async () => ({ auth: { apiKey: 'test' } }),
            hasConfiguredAuth: () => true,
            checkAuth: async () => undefined,
            isUsingOAuth: () => false,
            getModel: () => MODEL,
            getPhysicalModel: () => MODEL,
        } as unknown as ModelRuntime,
        tools: [],
    })
    await session.bindExtensions({})
    assert.ok(captured.pi, 'child extension captured the SDK API')

    const lifecycle: string[] = []
    const streamStarts: boolean[] = []
    const sent: string[] = []
    const streamWaiters: Array<() => void> = []
    let response = assistantMessage('Child answer.', 10, 5)
    let holdNext = false
    let releaseHeld: (() => void) | undefined

    session.subscribe((event) => {
        lifecycle.push(event.type)
    })
    const originalSend = session.sendCustomMessage.bind(session)
    session.sendCustomMessage = (async (message: never, options: never) => {
        sent.push(JSON.stringify((message as { content?: unknown }).content))
        return originalSend(message, options)
    }) as typeof session.sendCustomMessage

    session.agent.streamFunction = (
        _model: unknown,
        _context: unknown,
        options: unknown
    ) => {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        streamStarts.push(signal?.aborted === true)
        for (const resolve of streamWaiters.splice(0)) resolve()
        const stream = createAssistantMessageEventStream()
        const message = response
        let delivered = false
        const deliver = () => {
            if (delivered) return
            delivered = true
            if (signal?.aborted) {
                stream.push({
                    type: 'error',
                    reason: 'aborted',
                    error: abortedMessage(),
                })
            } else {
                stream.push({ type: 'done', reason: 'stop', message })
            }
        }
        if (holdNext) {
            holdNext = false
            releaseHeld = () => queueMicrotask(deliver)
            if (signal) {
                if (signal.aborted) queueMicrotask(deliver)
                else
                    signal.addEventListener(
                        'abort',
                        () => queueMicrotask(deliver),
                        { once: true }
                    )
            }
        } else {
            queueMicrotask(deliver)
        }
        return stream
    }
    const runtime = makeAgentRuntime({ path, session })
    return {
        runtime,
        session,
        pi: captured.pi,
        lifecycle,
        streamStarts,
        sent,
        setResponse: (text, input = 10, output = 5) => {
            response = assistantMessage(text, input, output)
        },
        holdNextResponse: () => {
            holdNext = true
        },
        releaseHeldResponse: () => {
            releaseHeld?.()
        },
        nextStreamStart: () =>
            new Promise((resolve) => {
                streamWaiters.push(resolve)
            }),
        resetLifecycle: () => {
            lifecycle.length = 0
        },
    }
}

function createCoordinator(
    directory: string,
    children: Map<string, ChildHarness>,
    completions: InterAgentCommunication[],
    config = DEFAULT_SUBAGENTS_CONFIG
): SubagentCoordinator {
    return new SubagentCoordinator({
        config,
        getRootSnapshot: () => ({
            path: ROOT_PATH,
            cwd: directory,
            model: MODEL,
            thinkingLevel: 'medium',
            activeTools: [],
            contextEntries: [],
            sessionId: 'root-session',
        }),
        rootEndpoint: {
            path: ROOT_PATH,
            send: async (comm) => {
                completions.push(comm)
            },
        },
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        sessionFactory: {
            create: async (record) =>
                children.get(record.path as string)!.runtime,
            open: async (record) =>
                children.get(record.path as string)!.runtime,
        },
    })
}

async function spawnTracked(
    coordinator: SubagentCoordinator,
    child: ChildHarness,
    taskName: string
): Promise<void> {
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName,
        message: 'Test',
        forkTurns: 'none',
    })
    await child.runtime.currentRun
}

async function createHarness(t: TestContext) {
    const directory = await createDirectory(t)
    const child = await createChild(directory, WORKER)
    const children = new Map<string, ChildHarness>([[WORKER, child]])
    const completions: InterAgentCommunication[] = []
    const coordinator = createCoordinator(directory, children, completions)
    t.after(() => coordinator.shutdown())
    t.after(() => child.releaseHeldResponse())

    function autonomousSend(text: string) {
        child.pi.sendMessage(
            {
                customType: 'background-terminal-result',
                content: text,
                display: true,
                details: { id: 'bt-1' },
            },
            { deliverAs: 'followUp', triggerTurn: true }
        )
    }

    return {
        coordinator,
        completions,
        session: child.session,
        runtime: child.runtime,
        lifecycle: child.lifecycle,
        sent: child.sent,
        spawn: () => spawnTracked(coordinator, child, 'worker'),
        respondWith: (text: string, input: number, output: number) =>
            child.setResponse(text, input, output),
        holdNextResponse: () => child.holdNextResponse(),
        releaseHeldResponse: () => child.releaseHeldResponse(),
        nextStreamStart: () => child.nextStreamStart(),
        resetLifecycle: () => child.resetLifecycle(),
        autonomousSend,
    }
}

test(
    'child usage is published before SDK persistence and is not counted twice at settlement',
    { timeout: 5_000 },
    async (t) => {
        const harness = await createHarness(t)
        await harness.spawn()
        const inputBefore =
            harness.coordinator.getRecordByPath(WORKER)!.usage!.input
        let atMessageEnd:
            { captured: number; persisted: number; models: number } | undefined
        harness.session.subscribe((event) => {
            if (
                event.type !== 'message_end' ||
                event.message.role !== 'assistant'
            )
                return
            const captured = harness.coordinator.getRecordByPath(WORKER)!.usage!
            atMessageEnd = {
                captured: captured.input,
                persisted: harness.session.getSessionStats().tokens.input,
                models: captured.models?.length ?? 0,
            }
        })
        harness.respondWith('New answer.', 100, 50)
        harness.autonomousSend('finished background work')
        await harness.session.waitForIdle()
        if (harness.runtime.currentRun) await harness.runtime.currentRun
        assert.deepEqual(atMessageEnd, {
            captured: inputBefore + 100,
            persisted: inputBefore,
            models: 1,
        })
        assert.equal(
            harness.coordinator.getRecordByPath(WORKER)!.usage!.input,
            inputBefore + 100
        )
    }
)

test('an autonomous child-extension turn is admitted and settled by the coordinator', async (t) => {
    const harness = await createHarness(t)
    await harness.spawn()
    assert.equal(harness.coordinator.list(ROOT_PATH)[0]?.status, 'Completed')
    assert.equal(harness.completions.length, 1)
    const sequence = harness.runtime.runSequence
    const usageBefore = harness.coordinator.getRecordByPath(WORKER)?.usage

    harness.respondWith('Autonomous answer.', 100, 50)
    harness.holdNextResponse()
    const started = waitForEvent(harness.session, 'agent_start')
    const streamStarted = harness.nextStreamStart()
    harness.autonomousSend('background terminal finished')
    await started

    // Public agent_start is asynchronous: state is asserted only after it is
    // observed, and the run is held so the window cannot close underneath.
    assert.equal(harness.coordinator.list(ROOT_PATH)[0]?.status, 'Running')
    assert.equal(harness.runtime.runSequence, sequence + 1)
    assert.notEqual(harness.runtime.activePermitSequence, undefined)

    // agent_start fires before the stream request, so release only once the
    // held stream has actually installed its release callback.
    await streamStarted
    harness.releaseHeldResponse()
    await harness.session.waitForIdle()
    if (harness.runtime.currentRun) await harness.runtime.currentRun

    // Settlement captures usage and propagates the final answer.
    assert.equal(harness.completions.length, 2)
    assert.equal(harness.completions[1]?.payload, 'Autonomous answer.')
    assert.equal(
        harness.coordinator.getRecordByPath(WORKER)?.usage?.input,
        (usageBefore?.input ?? 0) + 100
    )
})

test('a followup during an autonomous child-extension turn is not dropped', async (t) => {
    const harness = await createHarness(t)
    await harness.spawn()

    harness.respondWith('Autonomous answer.', 100, 50)
    const started = waitForEvent(harness.session, 'agent_start')
    harness.autonomousSend('background terminal finished')
    await started

    await harness.coordinator.followup({
        caller: ROOT_PATH,
        target: WORKER,
        message: 'Followup during native run.',
    })
    await harness.session.waitForIdle()
    if (harness.runtime.currentRun) await harness.runtime.currentRun

    assert.ok(
        harness.sent.some((content) =>
            content.includes('Followup during native run.')
        ),
        'followup must reach the child session instead of being dropped'
    )
})

test('an autonomous child-extension turn is visible on the public session event stream', async (t) => {
    const harness = await createHarness(t)
    await harness.spawn()

    harness.resetLifecycle()
    harness.respondWith('Autonomous answer.', 100, 50)
    harness.autonomousSend('background terminal finished')
    await harness.session.waitForIdle()

    // These are the supported hooks a coordinator can supervise with.
    assert.deepEqual(harness.lifecycle, [
        'agent_start',
        'turn_start',
        'message_start',
        'message_end',
        'message_start',
        'message_end',
        'turn_end',
        'agent_end',
        'agent_settled',
    ])
})

/**
 * Prospective fail-closed admission: when the only execution slot is
 * occupied, abort on the observed `agent_start`. This measures whether the
 * SDK delivers `agent_start` before the provider stream request and whether
 * the abort is observable to that request.
 */
test('with the single run slot occupied, abort on agent_start reaches the native stream', async (t) => {
    const directory = await createDirectory(t)
    const children = new Map<string, ChildHarness>()
    const completions: InterAgentCommunication[] = []
    const coordinator = createCoordinator(directory, children, completions, {
        ...DEFAULT_SUBAGENTS_CONFIG,
        maxConcurrentExecutions: 1,
    })
    t.after(() => coordinator.shutdown())

    const b = await createChild(directory, '/root/b' as AgentPath)
    children.set('/root/b', b)
    t.after(() => b.releaseHeldResponse())
    await spawnTracked(coordinator, b, 'b')

    const a = await createChild(directory, '/root/a' as AgentPath)
    children.set('/root/a', a)
    t.after(() => a.releaseHeldResponse())
    a.holdNextResponse()
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'Test',
        forkTurns: 'none',
    })
    // a occupies the only execution permit while it streams.
    assert.equal(a.runtime.phase, 'running')

    let admit = false
    b.session.subscribe((event) => {
        if (event.type === 'agent_start' && !admit) b.session.abort()
    })

    b.setResponse('Native answer.')
    b.streamStarts.length = 0
    const started = waitForEvent(b.session, 'agent_start')
    b.pi.sendMessage(
        {
            customType: 'background-terminal-result',
            content: 'background terminal finished',
            display: true,
            details: {},
        },
        { deliverAs: 'followUp', triggerTurn: true }
    )
    await started
    await b.session.waitForIdle()
    await flush()

    assert.equal(b.streamStarts.length, 1, 'the stream is requested once')
    assert.equal(
        b.streamStarts[0],
        true,
        'abort on agent_start marks the signal before the stream request'
    )
    assert.equal(
        b.session.getLastAssistantText(),
        'Child answer.',
        'no new normal answer is produced by the blocked run'
    )
    assert.ok(
        b.session.messages.some(
            (message) =>
                (message as { stopReason?: string }).stopReason === 'aborted'
        ),
        'the blocked native run finished aborted'
    )
    assert.ok(
        JSON.stringify(b.session.messages).includes(
            'background terminal finished'
        ),
        'the native custom message stays in the transcript'
    )

    a.releaseHeldResponse()
    await a.runtime.currentRun

    admit = true
    b.setResponse('Recovered.')
    await coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/b' as AgentPath,
        message: 'Retry',
    })
    await b.runtime.currentRun
    assert.equal(b.session.getLastAssistantText(), 'Recovered.')
})

/**
 * Production contract for a capacity-blocked autonomous run under
 * `maxConcurrentExecutions: 1`: the run must not start work, must be marked
 * Interrupted, and a followup issued in the same window must not be lost.
 */
test('a capacity-blocked autonomous run is interrupted and keeps its followup', async (t) => {
    const directory = await createDirectory(t)
    const children = new Map<string, ChildHarness>()
    const completions: InterAgentCommunication[] = []
    const coordinator = createCoordinator(directory, children, completions, {
        ...DEFAULT_SUBAGENTS_CONFIG,
        maxConcurrentExecutions: 1,
    })
    t.after(() => coordinator.shutdown())

    const b = await createChild(directory, '/root/b' as AgentPath)
    children.set('/root/b', b)
    t.after(() => b.releaseHeldResponse())
    await spawnTracked(coordinator, b, 'b')

    const a = await createChild(directory, '/root/a' as AgentPath)
    children.set('/root/a', a)
    t.after(() => a.releaseHeldResponse())
    a.holdNextResponse()
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'a',
        message: 'Test',
        forkTurns: 'none',
    })
    assert.equal(a.runtime.phase, 'running')

    b.setResponse('Native answer.')
    const started = waitForEvent(b.session, 'agent_start')
    b.pi.sendMessage(
        {
            customType: 'background-terminal-result',
            content: 'background terminal finished',
            display: true,
            details: {},
        },
        { deliverAs: 'followUp', triggerTurn: true }
    )
    await started

    await coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/b' as AgentPath,
        message: 'Followup during blocked run.',
    })
    await b.session.waitForIdle()
    await flush()

    assert.deepEqual(
        {
            status: coordinator
                .list(ROOT_PATH)
                .find((agent) => agent.path === '/root/b')?.status,
            followupDelivered: b.sent.some((content) =>
                content.includes('Followup during blocked run.')
            ),
        },
        {
            status: 'Interrupted',
            followupDelivered: true,
        }
    )

    a.releaseHeldResponse()
    await a.runtime.currentRun
    b.setResponse('Recovered.')
    await coordinator.followup({
        caller: ROOT_PATH,
        target: '/root/b' as AgentPath,
        message: 'Retry',
    })
    await b.runtime.currentRun
    assert.equal(
        coordinator.list(ROOT_PATH).find((agent) => agent.path === '/root/b')
            ?.status,
        'Completed'
    )
})

/**
 * `background-terminals` flushes a finished terminal from `agent_settled`
 * (index.ts), so the native run starts while the previous tracked run is
 * still settling, before its `sendCustomMessage` promise resolves.
 */
test('a native wake during the settling window does not replace the tracked completion', async (t) => {
    const directory = await createDirectory(t)
    const children = new Map<string, ChildHarness>()
    const completions: InterAgentCommunication[] = []
    const coordinator = createCoordinator(directory, children, completions)
    t.after(() => coordinator.shutdown())

    // The wake comes from a real extension agent_settled handler.
    const worker = await createChild(directory, WORKER, {
        wakeOnSettled: 'background terminal finished',
    })
    children.set(WORKER, worker)
    t.after(() => worker.releaseHeldResponse())

    const order: string[] = []
    let sawTrackedSettled = false
    worker.session.subscribe((event) => {
        if (event.type === 'agent_settled' && !sawTrackedSettled) {
            sawTrackedSettled = true
            order.push('tracked:agent_settled')
        } else if (
            event.type === 'agent_start' &&
            worker.sent.some((content) =>
                content.includes('background terminal finished')
            )
        ) {
            order.push('native:agent_start')
        }
    })

    worker.holdNextResponse()
    worker.setResponse('Tracked answer.')
    const trackedStream = worker.nextStreamStart()
    await coordinator.spawn({
        caller: ROOT_PATH,
        taskName: 'worker',
        message: 'Test',
        forkTurns: 'none',
    })
    const trackedRun = worker.runtime.currentRun
    await trackedStream
    worker.setResponse('Native answer.')
    worker.releaseHeldResponse()
    await trackedRun
    if (worker.runtime.currentRun) await worker.runtime.currentRun
    await worker.session.waitForIdle()
    await flush()

    // The SDK order is unchanged: the deferred wake starts at the settling
    // boundary, after the tracked agent_settled notification.
    assert.deepEqual(order, ['tracked:agent_settled', 'native:agent_start'])

    // The old tracked settlement must not consume the new native run: both
    // answers are delivered in order, the native run gets its own sequence,
    // and the record finishes Completed with no residual permit or run.
    assert.deepEqual(
        completions.map((completion) => completion.payload),
        ['Tracked answer.', 'Native answer.']
    )
    assert.equal(worker.runtime.runSequence, 2)
    assert.equal(coordinator.list(ROOT_PATH)[0]?.status, 'Completed')
    assert.equal(worker.runtime.activePermitSequence, undefined)
    assert.equal(worker.runtime.currentRun, undefined)
})

/**
 * The factory hook the coordinator wires at construction (coordinator.ts
 * `onRuntimeCreated`): the observer must attach before `bindExtensions` so a
 * `session_start` extension that sends a startup wake is still observed as a
 * native run, and the factory-started extension keeps working.
 *
 * This exercises `SessionFactory` directly with the same callback shape the
 * coordinator passes; the coordinator's private observer is not reachable
 * here because the default factory builds its own `createAgentSession` and
 * exposes no stream-injection seam. The coordinator-level custom-factory path
 * (observation after `registerRuntime`) is covered by the other tests.
 */
test('SessionFactory.onRuntimeCreated attaches before a session_start extension wake', async (t) => {
    const directory = await createDirectory(t)
    const agentDir = join(directory, 'agent')
    await mkdir(join(agentDir, 'extensions'), { recursive: true })
    await writeFile(
        join(agentDir, 'extensions', 'startup-wake.ts'),
        [
            'export default function startupWake(pi) {',
            "    pi.on('session_start', () => {",
            '        pi.sendMessage(',
            "            { customType: 'startup-wake', content: 'startup wake', display: true, details: {} },",
            '            { triggerTurn: true }',
            '        )',
            '    })',
            '}',
            '',
        ].join('\n')
    )

    // Isolate the agent dir so the factory's default settings and model
    // runtime never read the user's real ~/.pi/agent.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    t.after(() => {
        if (previousAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR
        } else {
            process.env.PI_CODING_AGENT_DIR = previousAgentDir
        }
    })

    // Mirrors the coordinator observer contract: reserve on agent_start,
    // settle on agent_settled (not agent_end, which retries can precede).
    const observed: string[] = []
    let reserved = 0
    let settled = 0
    const factory = new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => '',
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        agentDir,
        config: DEFAULT_SUBAGENTS_CONFIG,
        onRuntimeCreated: (_record, runtime) => {
            observed.push('runtime-created')
            // Simulated provider: no network or auth lookup.
            runtime.session.agent.streamFunction = () => {
                observed.push('stream')
                const stream = createAssistantMessageEventStream()
                queueMicrotask(() =>
                    stream.push({
                        type: 'done',
                        reason: 'stop',
                        message: assistantMessage('Startup answer.', 1, 1),
                    })
                )
                return stream
            }
            runtime.session.agent.getApiKey = async () => 'test'
            runtime.session.subscribe((event) => {
                if (event.type === 'agent_start') {
                    observed.push('agent_start')
                    reserved += 1
                } else if (event.type === 'agent_end') {
                    observed.push('agent_end')
                } else if (event.type === 'agent_settled') {
                    observed.push('agent_settled')
                    settled += 1
                }
            })
        },
    })

    const record = {
        id: 'a1',
        path: WORKER,
        parentId: null,
        parentPath: ROOT_PATH,
        status: { _tag: 'PendingInit' },
        residency: 'loading',
        model: `${MODEL.provider}/${MODEL.id}`,
        cwd: directory,
        activeTools: [],
        thinkingLevel: 'medium',
        runSequence: 0,
    } as unknown as AgentRecord
    const parent: ParentExecutionSnapshot = {
        path: ROOT_PATH,
        cwd: directory,
        model: { provider: MODEL.provider, id: MODEL.id },
        thinkingLevel: 'medium',
        activeTools: [],
        contextEntries: [],
        sessionId: 'root-session',
    }

    const runtime = await factory.create(record, parent, { _tag: 'None' })
    t.after(() => runtime.dispose())
    await runtime.session.waitForIdle()

    // The observer attached before the startup wake ran, then saw the native
    // run start, request the provider stream, and settle exactly once.
    assert.deepEqual(observed.slice(0, 3), [
        'runtime-created',
        'agent_start',
        'stream',
    ])
    assert.ok(observed.indexOf('agent_end') < observed.indexOf('agent_settled'))
    assert.equal(reserved, 1)
    assert.equal(settled, 1)
    assert.equal(runtime.session.getLastAssistantText(), 'Startup answer.')
})
