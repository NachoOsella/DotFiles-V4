import assert from 'node:assert/strict'
import test from 'node:test'
import { Layer, ManagedRuntime } from 'effect'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BackendRegistry, type SubagentBackend } from './src/backend.ts'
import { makeStubBackend } from './src/backends/stub.ts'
import { createSubagentsExtension } from './index.ts'
import type { BackendName } from './src/domain.ts'
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
