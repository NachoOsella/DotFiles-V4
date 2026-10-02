/**
 * Terminal status from native generation task receipts.
 *
 * Real Harness and faux provider. Status must come from the newest own
 * generation task, not from assistant history, so an abort before any output
 * and a no-model failure are visible, and passive writes cannot hide a
 * completed answer.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import type {
    ConversationId,
    LiveState,
    ToolExecutionApi,
} from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import {
    openSubagentsHarness,
    type SubagentsHarnessHandle,
} from '../src/host.js'
import { listAgents, type ListedAgent } from '../src/runtime/list.js'
import type { RuntimeDeps } from '../src/runtime/context.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000
): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs)
            throw new Error('timed out waiting for the provider gate')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

async function registerAgent(
    handle: SubagentsHarnessHandle,
    path: string
): Promise<ConversationId> {
    return handle.harness.commit(async (tx) => {
        const state = await tx.doc(SubagentsDoc)
        const conversation = await tx.createConversation({
            ownership: { kind: 'ownerless' },
        })
        state.agents[path] = {
            name: path.split('/').at(-1) ?? path,
            path,
            parentPath: '/root',
            conversationId: conversation.id,
            createdAt: Date.now(),
        }
        return conversation.id
    }, BACKGROUND_CONTEXT)
}

/** Minimal ToolExecutionApi adapter over the real Harness, for direct list_agents calls. */
function toolApi(harness: SubagentsHarnessHandle['harness']): ToolExecutionApi {
    const snapshot = harness.snapshot.bind(harness) as unknown as (
        token: unknown,
        first: unknown,
        second?: unknown
    ) => Promise<unknown>
    const commit = harness.commit.bind(harness) as unknown as (
        change: (tx: unknown) => unknown,
        context: Context
    ) => Promise<unknown>
    return {
        snapshot: (token: unknown, first: unknown, second?: unknown) =>
            snapshot(token, first, second),
        commit: (change: (tx: unknown) => unknown, context: Context) =>
            commit(change, context),
    } as unknown as ToolExecutionApi
}

async function listStatus(
    handle: SubagentsHarnessHandle,
    path: string
): Promise<ListedAgent['agent_status']> {
    const details = await listAgents(
        {} as RuntimeDeps,
        toolApi(handle.harness),
        {},
        BACKGROUND_CONTEXT
    )
    const agent = details.agents.find(
        (candidate) => candidate.agent_name === path
    )
    assert.ok(agent, `list_agents has ${path}`)
    return agent.agent_status
}

/** Resolve once the conversation's live tool round shows a running wait_agent call. */
async function waitForRunningWaitSlot(
    handle: SubagentsHarnessHandle,
    conversationId: ConversationId
): Promise<void> {
    const watch = await handle.harness.watchDoc(
        LiveDoc,
        conversationId,
        BACKGROUND_CONTEXT
    )
    if (watch === undefined) throw new Error('live document missing')
    const hasSlot = (value: Readonly<LiveState> | null): boolean =>
        (value?.tools ?? []).some(
            (slot) => slot.name === 'wait_agent' && slot.status === 'running'
        )
    if (hasSlot(watch.value)) {
        void watch.stop()
        return
    }
    await new Promise<void>((resolve) => {
        watch.start(async (value) => {
            if (hasSlot(value)) resolve()
        })
    })
    void watch.stop()
}

async function setup() {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const handle = await openSubagentsHarness(
        { models, storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    const conversationId = await registerAgent(handle, '/root/child')
    const conversation = await handle.harness.conversation(
        conversationId,
        BACKGROUND_CONTEXT
    )
    assert.ok(conversation)
    await conversation.configure(
        {
            model: {
                provider: faux.getModel().provider,
                modelId: faux.getModel().id,
            },
        },
        BACKGROUND_CONTEXT
    )
    return { faux, handle, conversationId, conversation }
}

test('abort before the first output of a later generation reports Interrupted', async () => {
    const { faux, handle, conversation } = await setup()
    try {
        faux.appendResponses([fauxAssistantMessage('first answer')])
        const first = await conversation.submit(
            { type: 'input', content: 'one' },
            BACKGROUND_CONTEXT
        )
        assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done')
        assert.equal(await listStatus(handle, '/root/child'), 'Completed')

        let releaseGate!: () => void
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve
        })
        let started = false
        const gated: FauxResponseFactory = async (_context, options) => {
            started = true
            await Promise.race([
                gate,
                new Promise<void>((resolve) => {
                    if (options?.signal?.aborted === true) resolve()
                    else
                        options?.signal?.addEventListener(
                            'abort',
                            () => resolve(),
                            { once: true }
                        )
                }),
            ])
            return fauxAssistantMessage('second answer', {
                stopReason:
                    options?.signal?.aborted === true ? 'aborted' : 'stop',
            })
        }
        faux.appendResponses([gated])
        const second = await conversation.submit(
            { type: 'input', content: 'two' },
            BACKGROUND_CONTEXT
        )
        await waitFor(() => started)
        await conversation.abort(BACKGROUND_CONTEXT)
        releaseGate()
        assert.equal(
            (await second.wait(BACKGROUND_CONTEXT)).status,
            'unanswered'
        )

        assert.equal(await listStatus(handle, '/root/child'), 'Interrupted')
        const agent = (await handle.project(BACKGROUND_CONTEXT)).agents.find(
            (candidate) => candidate.path === '/root/child'
        )
        assert.equal(agent?.status, 'interrupted')
        assert.match(agent?.lastAnswer ?? '', /first answer/)
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('a missing model after an earlier success reports Errored', async () => {
    const { faux, handle, conversation } = await setup()
    try {
        faux.appendResponses([fauxAssistantMessage('first answer')])
        const first = await conversation.submit(
            { type: 'input', content: 'one' },
            BACKGROUND_CONTEXT
        )
        assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done')

        await conversation.configure(
            { model: { provider: 'missing', modelId: 'missing' } },
            BACKGROUND_CONTEXT
        )
        const second = await conversation.submit(
            { type: 'input', content: 'two' },
            BACKGROUND_CONTEXT
        )
        const settled = await second.wait(BACKGROUND_CONTEXT)
        assert.equal(settled.status, 'unanswered')

        assert.equal(await listStatus(handle, '/root/child'), 'Errored')
        const agent = (await handle.project(BACKGROUND_CONTEXT)).agents.find(
            (candidate) => candidate.path === '/root/child'
        )
        assert.equal(agent?.status, 'errored')
        assert.match(agent?.lastAnswer ?? '', /first answer/)
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('many passive writes do not reset a Completed status', async () => {
    const { faux, handle, conversation } = await setup()
    try {
        faux.appendResponses([fauxAssistantMessage('first answer')])
        const first = await conversation.submit(
            { type: 'input', content: 'one' },
            BACKGROUND_CONTEXT
        )
        assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, 'done')

        for (let index = 0; index < 60; index++) {
            const write = await conversation.submit(
                { type: 'write', entry: { kind: 'app.note', data: { index } } },
                BACKGROUND_CONTEXT
            )
            assert.equal((await write.wait(BACKGROUND_CONTEXT)).status, 'done')
        }

        assert.equal(await listStatus(handle, '/root/child'), 'Completed')
        const agent = (await handle.project(BACKGROUND_CONTEXT)).agents.find(
            (candidate) => candidate.path === '/root/child'
        )
        assert.equal(agent?.status, 'completed')
        assert.match(agent?.lastAnswer ?? '', /first answer/)
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('a child blocked in wait_agent lists as Waiting and projects as waiting', async () => {
    const models = createModels()
    const fauxWaiter = fauxProvider({
        provider: 'faux-waiter',
        models: [{ id: 'waiter-1' }],
    })
    const fauxDriver = fauxProvider({
        provider: 'faux-driver',
        models: [{ id: 'driver-1' }],
    })
    models.setProvider(fauxWaiter.provider)
    models.setProvider(fauxDriver.provider)
    const handle = await openSubagentsHarness(
        { models, storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        const waiterId = await registerAgent(handle, '/root/waiter')
        const waiter = await handle.harness.conversation(
            waiterId,
            BACKGROUND_CONTEXT
        )
        assert.ok(waiter)
        await waiter.configure(
            {
                model: {
                    provider: fauxWaiter.getModel().provider,
                    modelId: fauxWaiter.getModel().id,
                },
            },
            BACKGROUND_CONTEXT
        )
        fauxWaiter.appendResponses([
            fauxAssistantMessage(
                [fauxToolCall('wait_agent', { timeout_ms: 3_600_000 })],
                { stopReason: 'toolUse' }
            ),
        ])
        const waiterSubmission = await waiter.submit(
            { type: 'input', content: 'wait' },
            BACKGROUND_CONTEXT
        )

        // The child is held only once its live round shows a running wait_agent call.
        await waitForRunningWaitSlot(handle, waiterId)

        const root = await handle.harness.root(BACKGROUND_CONTEXT)
        await root.configure(
            {
                model: {
                    provider: fauxDriver.getModel().provider,
                    modelId: fauxDriver.getModel().id,
                },
            },
            BACKGROUND_CONTEXT
        )
        fauxDriver.appendResponses([
            fauxAssistantMessage([fauxToolCall('list_agents', {})], {
                stopReason: 'toolUse',
            }),
            fauxAssistantMessage('done'),
        ])
        const driverSubmission = await root.submit(
            { type: 'input', content: 'inspect' },
            BACKGROUND_CONTEXT
        )
        assert.equal(
            (await driverSubmission.wait(BACKGROUND_CONTEXT)).status,
            'done'
        )

        const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT)
        const result = page.items
            .map((entry) => entry.model?.[0])
            .find(
                (message) =>
                    message?.role === 'toolResult' &&
                    message.toolName === 'list_agents'
            )
        assert.ok(result?.role === 'toolResult')
        const details = result.details as
            { readonly agents?: readonly ListedAgent[] } | undefined
        const row = details?.agents?.find(
            (agent) => agent.agent_name === '/root/waiter'
        )
        assert.equal(row?.agent_status, 'Waiting')
        assert.equal(row?.running, true)
        assert.equal(row?.waiting, true)

        const projected = (
            await handle.project(BACKGROUND_CONTEXT)
        ).agents.find((agent) => agent.path === '/root/waiter')
        assert.equal(projected?.status, 'waiting')

        await waiter.abort(BACKGROUND_CONTEXT)
        await waiterSubmission.wait(BACKGROUND_CONTEXT)
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})
