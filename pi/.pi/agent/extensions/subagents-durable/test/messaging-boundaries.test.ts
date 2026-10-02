/**
 * Busy `send_message` boundary through the real Harness.
 *
 * A child generation is held inside a real tool round. While it is held, the
 * root calls the actual `send_message` tool. The passive write must be a full
 * MESSAGE envelope queued as a write (never a child input), must not start
 * another child run, and must be visible to the child's next provider request
 * once the held tool releases.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Type, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory, Message } from '@earendil-works/pi-ai'
import {
    InboxDoc,
    LiveDoc,
    defineExtension,
    defineTool,
} from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { formatEnvelope } from '../src/domain/communication.js'
import {
    createAgentConversation,
    createReporterTask,
} from '../src/testing/index.js'
import {
    configureRoot,
    createCoreHarness,
    lastUserText,
    until,
} from './support.js'

function messageText(message: Message): string {
    if (typeof message.content === 'string') return message.content
    const parts: string[] = []
    for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text)
    }
    return parts.join('\n')
}

test('a held child receives send_message as a queued MESSAGE envelope for its next request', async () => {
    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => {
        releaseHold = resolve
    })
    let holdStarted!: () => void
    const holdStartedPromise = new Promise<void>((resolve) => {
        holdStarted = resolve
    })
    const holdTool = defineTool({
        name: 'hold',
        description: 'Hold the child tool round until released.',
        parameters: Type.Object({}),
        execute: async () => {
            holdStarted()
            await holdGate
            return { content: [{ type: 'text' as const, text: 'hold result' }] }
        },
    })
    const slowTools = defineExtension({ name: 'slow-tools', tools: [holdTool] })

    const th = await createCoreHarness(DEFAULT_CONFIG, [slowTools])
    try {
        const root = await configureRoot(th)
        const child = await createAgentConversation(th, {
            path: '/root/child',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        const childConversation = await th.harness.conversation(
            child.conversationId,
            th.context
        )
        assert.ok(childConversation)

        const childRequests: Message[][] = []
        const isChildRequest = (messages: readonly Message[]): boolean =>
            messages.some(
                (message) =>
                    message.role === 'toolResult' && message.toolName === 'hold'
            ) || lastUserText(messages).includes('original child work')

        const factory: FauxResponseFactory = (request) => {
            const messages = [...request.messages]
            if (isChildRequest(messages)) childRequests.push(messages)
            const text = lastUserText(messages)
            if (text.includes('Message Type: MESSAGE')) {
                return fauxAssistantMessage('child saw the message')
            }
            if (
                messages.some(
                    (message) =>
                        message.role === 'toolResult' &&
                        message.toolName === 'hold'
                )
            ) {
                return fauxAssistantMessage('child answer after hold')
            }
            if (text.includes('original child work')) {
                return fauxAssistantMessage(
                    [fauxToolCall('hold', {}, { id: 'hold-1' })],
                    { stopReason: 'toolUse' }
                )
            }
            if (
                messages.some(
                    (message) =>
                        message.role === 'toolResult' &&
                        message.toolName === 'send_message'
                )
            ) {
                return fauxAssistantMessage('root ack')
            }
            if (text.includes('root send')) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall(
                            'send_message',
                            { target: '/root/child', message: 'boundary note' },
                            { id: 'send-1' }
                        ),
                    ],
                    { stopReason: 'toolUse' }
                )
            }
            return fauxAssistantMessage('idle')
        }
        th.faux!.setResponses(Array.from({ length: 60 }, () => factory))

        const original = await childConversation.submit(
            {
                type: 'input',
                content: 'original child work',
                requestId: 'child-1',
            },
            th.context
        )
        await holdStartedPromise
        assert.equal(
            childRequests.length,
            1,
            'the child made its tool-call request and is now held'
        )

        const rootSubmission = await root.submit(
            { type: 'input', content: 'root send' },
            th.context
        )
        const rootSettled = await rootSubmission.wait(th.context)
        assert.equal(rootSettled.status, 'done')

        const expectedEnvelope = formatEnvelope(
            'MESSAGE',
            'child',
            '/root',
            'boundary note'
        )
        const inbox = await th.harness.snapshot(
            InboxDoc,
            child.conversationId,
            th.context
        )
        const items = inbox?.items ?? []
        assert.ok(
            items.length >= 1,
            'the passive write is queued in the child inbox'
        )
        assert.ok(
            items.every((item) => item.mode === 'write'),
            'send_message queues a write, never a child input'
        )
        const queuedEnvelopes = items.flatMap((item) => {
            if (item.mode !== 'write') return []
            const entry = item.entry as {
                readonly model?: readonly { readonly content?: unknown }[]
            }
            return (entry.model ?? []).map((message) =>
                typeof message.content === 'string' ? message.content : ''
            )
        })
        assert.ok(
            queuedEnvelopes.includes(expectedEnvelope),
            `queued envelope is complete: ${JSON.stringify(queuedEnvelopes)}`
        )
        assert.equal(
            childRequests.length,
            1,
            'the held child started no second run for the passive write'
        )

        releaseHold()
        const childSettled = await original.wait(th.context)
        assert.equal(childSettled.status, 'done')
        assert.equal(
            childRequests.length,
            2,
            'releasing the tool places the write and starts the next request'
        )
        const nextRequest = childRequests[1]!
        assert.ok(
            nextRequest.some(
                (message) =>
                    message.role === 'user' &&
                    messageText(message).includes(expectedEnvelope)
            ),
            'the child next model context includes the full MESSAGE envelope'
        )

        const committed = await childConversation.context(th.context)
        assert.match(
            JSON.stringify(committed.messages),
            /Message Type: MESSAGE\\nTask name: child\\nSender: \/root/
        )
    } finally {
        releaseHold()
        await th.harness.close(th.context)
    }
})

test('aborting a root wait leaves the background child and its report alive', async () => {
    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => {
        releaseHold = resolve
    })
    let holdStarted!: () => void
    const holdStartedPromise = new Promise<void>((resolve) => {
        holdStarted = resolve
    })
    const holdTool = defineTool({
        name: 'hold',
        description: 'Hold the child tool round until released.',
        parameters: Type.Object({}),
        execute: async () => {
            holdStarted()
            await holdGate
            return { content: [{ type: 'text' as const, text: 'hold result' }] }
        },
    })
    const slowTools = defineExtension({ name: 'slow-tools', tools: [holdTool] })

    const th = await createCoreHarness(DEFAULT_CONFIG, [slowTools])
    try {
        const root = await configureRoot(th)
        const child = await createAgentConversation(th, {
            path: '/root/child',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        const factory: FauxResponseFactory = (request) => {
            const messages = request.messages
            const text = lastUserText(messages)
            if (text.includes('Message Type: FINAL_ANSWER')) {
                return fauxAssistantMessage('root ack')
            }
            if (
                messages.some(
                    (message) =>
                        message.role === 'toolResult' &&
                        message.toolName === 'hold'
                )
            ) {
                return fauxAssistantMessage('child answer after hold')
            }
            if (text.includes('Message Type: NEW_TASK')) {
                return fauxAssistantMessage(
                    [fauxToolCall('hold', {}, { id: 'hold-1' })],
                    { stopReason: 'toolUse' }
                )
            }
            if (text.includes('root wait')) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall(
                            'wait_agent',
                            { targets: ['/root/child'] },
                            { id: 'wait-1' }
                        ),
                    ],
                    { stopReason: 'toolUse' }
                )
            }
            return fauxAssistantMessage('idle')
        }
        th.faux!.setResponses(Array.from({ length: 60 }, () => factory))

        const reporterId = await createReporterTask(th, {
            childPath: '/root/child',
            childId: child.conversationId,
            parentPath: '/root',
            parentId: root.id,
            content: formatEnvelope('NEW_TASK', 'child', '/root', 'held work'),
            whenBusy: 'steer',
        })
        await holdStartedPromise

        const waiting = await root.submit(
            { type: 'input', content: 'root wait' },
            th.context
        )
        await until(async () => {
            const live = await th.harness.snapshot(LiveDoc, root.id, th.context)
            return (live?.tools ?? []).some(
                (tool) =>
                    tool.name === 'wait_agent' && tool.status === 'running'
            )
        })

        await root.abort(th.context)
        const waitingSettled = await waiting.wait(th.context)
        assert.ok(
            waitingSettled.status === 'unanswered' ||
                waitingSettled.status === 'done',
            'the aborted wait leaves a terminal submission'
        )

        const reporterWhileHeld = await th.harness.getTask(
            reporterId,
            th.context
        )
        assert.ok(reporterWhileHeld)
        assert.notEqual(
            reporterWhileHeld.state.status,
            'terminal',
            'the background reporter survives the ordinary root abort'
        )
        const childLive = await th.harness.snapshot(
            LiveDoc,
            child.conversationId,
            th.context
        )
        assert.ok(
            childLive?.run !== undefined,
            'the held child run is still alive after the wait was cancelled'
        )

        releaseHold()
        const reporterSettled = await th.harness.waitForTask(
            reporterId,
            th.context
        )
        assert.equal(reporterSettled.state.outcome.status, 'completed')
        assert.equal(
            reporterSettled.state.outcome.status === 'completed'
                ? reporterSettled.state.outcome.result.reported
                : false,
            true
        )
        await until(async () => {
            const messages = (await root.context(th.context)).messages
            return messages.some(
                (message) =>
                    message.role === 'user' &&
                    messageText(message).includes('child answer after hold')
            )
        })
    } finally {
        releaseHold()
        await th.harness.close(th.context)
    }
})
