/**
 * Wait initialization regression.
 *
 * A spawned child commits its identity and its reporter intent before the
 * reporter admits the first child input. A target wait that races
 * `child.waitForIdle` independently can therefore return immediately while the
 * reporter is still pending and the child is still idle. This test holds the
 * real reporter's `submit` phase at a public task-phase boundary, so the child
 * has no admitted input, and proves the target wait observes the live reporter
 * and reaches its real deadline.
 *
 * The gated task reuses the production `ReporterTask` definition and body; only
 * the phase boundary is wrapped. This is not a fake Harness.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import { defineTask } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { formatEnvelope } from '../src/domain/communication.js'
import {
    createSubagentsExtension,
    type PassiveWriter,
} from '../src/extension.js'
import { AnchorTask } from '../src/tasks/anchor-task.js'
import {
    ReporterTask,
    type ReporterCheckpoint,
    type ReporterInput,
    type ReporterResult,
} from '../src/tasks/reporter-task.js'
import {
    createAgentConversation,
    createReporterTask,
    createTestHarness,
    type TestHarness,
} from '../src/testing/index.js'
import { lastUserText, until } from './support.js'

type RequestContext = Parameters<FauxResponseFactory>[0]

test('a target wait observes a pending reporter instead of an idle child', async () => {
    let releaseGate!: () => void
    const released = new Promise<void>((resolve) => {
        releaseGate = resolve
    })
    let gateHit!: () => void
    const hit = new Promise<void>((resolve) => {
        gateHit = resolve
    })

    const gatedReporter = defineTask<
        ReporterInput,
        ReporterCheckpoint,
        ReporterResult
    >({
        ...ReporterTask.definition,
        phases: {
            ...ReporterTask.definition.phases,
            submit: async (task, runtime, context) => {
                gateHit()
                await released
                return ReporterTask.definition.phases.submit(
                    task,
                    runtime,
                    context
                )
            },
        },
    })

    let harness: TestHarness['harness'] | undefined
    const submitWrite: PassiveWriter = async (id, draft, context) => {
        if (harness === undefined) throw new Error('harness is not ready')
        const conversation = await harness.conversation(id, context)
        if (conversation === undefined) {
            throw new Error(`Conversation ${id} is missing.`)
        }
        return conversation.submit(draft, context)
    }
    const base = createSubagentsExtension({
        config: {
            ...DEFAULT_CONFIG,
            wait: { defaultTimeoutMs: 40, minTimeoutMs: 0, maxTimeoutMs: 1000 },
        },
        submitWrite,
    })
    const extension: Extension = { ...base, tasks: [AnchorTask, gatedReporter] }
    const th = await createTestHarness({ extensions: [extension] })
    harness = th.harness

    try {
        const root = await th.harness.root(th.context)
        await root.configure(
            { model: { provider: th.provider, modelId: th.modelId } },
            th.context
        )
        const child = await createAgentConversation(th, {
            path: '/root/child',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        await createReporterTask(th, {
            childPath: '/root/child',
            childId: child.conversationId,
            parentPath: '/root',
            parentId: root.id,
            content: formatEnvelope('NEW_TASK', 'child', '/root', 'held work'),
            whenBusy: 'steer',
        })
        await hit

        const factory: FauxResponseFactory = (request: RequestContext) => {
            const text = lastUserText(request.messages)
            if (text.includes('Message Type: FINAL_ANSWER')) {
                return fauxAssistantMessage('ack')
            }
            if (
                text.startsWith('Message Type: NEW_TASK') &&
                text.includes('Task name: child')
            ) {
                return fauxAssistantMessage('child answer')
            }
            if (text.includes('timed out')) {
                return fauxAssistantMessage('done')
            }
            if (text.includes('wait child')) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall(
                            'wait_agent',
                            { targets: ['/root/child'], timeout_ms: 40 },
                            { id: 'wait-1' }
                        ),
                    ],
                    { stopReason: 'toolUse' }
                )
            }
            return fauxAssistantMessage('idle')
        }
        th.faux!.setResponses(Array.from({ length: 30 }, () => factory))

        const submission = await root.submit(
            { type: 'input', content: 'wait child' },
            th.context
        )
        await submission.wait(th.context)

        const messages = (await root.context(th.context)).messages
        assert.ok(
            messages.some(
                (message) =>
                    message.role === 'toolResult' &&
                    textOf(message).includes('timed out')
            ),
            'the target wait must reach its deadline while the reporter is gated'
        )

        const childView = await (await th.harness.conversation(
            child.conversationId,
            th.context
        ))!.context(th.context)
        assert.equal(
            childView.messages.some((message) =>
                textOf(message).includes('held work')
            ),
            false,
            'the gated reporter must not have admitted the input yet'
        )

        releaseGate()
        await until(async () => {
            const view = await (await th.harness.conversation(
                child.conversationId,
                th.context
            ))!.context(th.context)
            return view.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    textOf(message).includes('child answer')
            )
        })
        await th.harness.waitForIdle(th.context)
    } finally {
        releaseGate()
        await th.harness.close(th.context)
    }
})

function textOf(message: { readonly content: unknown }): string {
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
        .map((block) =>
            block !== null &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
                ? (block as { text: string }).text
                : ''
        )
        .join('')
}
