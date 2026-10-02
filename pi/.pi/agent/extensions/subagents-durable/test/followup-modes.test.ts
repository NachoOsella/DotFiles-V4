/**
 * Busy queue-mode semantics through the real Harness.
 *
 * A child generation is held inside a tool round. While it is held, the parent
 * admits one steer and one explicit followUp. Releasing the tool proves:
 * - the steer joins the held run, so the original input and the steer settle to
 *   one shared answer entry;
 * - the followUp waits for that answer and then starts a successor run with a
 *   distinct answer entry;
 * - the background reporter reports exactly once per distinct answer, because
 *   the parent request ID is answer-keyed.
 *
 * The reporters use the production `ReporterTask` admitted through the same
 * `childRequestId` adoption path `followup_task` uses; the routing under test is
 * `whenBusy` steer/followUp placement, not a reimplementation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Type, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
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

type RequestContext = Parameters<FauxResponseFactory>[0]

test('steer joins the held run while followUp waits for the answer', async () => {
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
        description: 'Hold the round until the test releases it.',
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
        const factory: FauxResponseFactory = (request: RequestContext) => {
            const text = lastUserText(request.messages)
            const hasToolResult = request.messages.some(
                (message) => message.role === 'toolResult'
            )
            if (text.includes('Message Type: FINAL_ANSWER')) {
                return fauxAssistantMessage('ack')
            }
            if (text.includes('follow up')) {
                return fauxAssistantMessage('answer two')
            }
            if (hasToolResult) return fauxAssistantMessage('answer one')
            if (text.includes('original')) {
                return fauxAssistantMessage(
                    [fauxToolCall('hold', {}, { id: 'hold-1' })],
                    { stopReason: 'toolUse' }
                )
            }
            return fauxAssistantMessage('idle')
        }
        th.faux!.setResponses(Array.from({ length: 40 }, () => factory))

        const childConversation = await th.harness.conversation(
            child.conversationId,
            th.context
        )
        const original = await childConversation!.submit(
            {
                type: 'input',
                content: 'original',
                whenBusy: 'steer',
                requestId: 'orig',
            },
            th.context
        )
        await holdStartedPromise
        const steer = await childConversation!.submit(
            {
                type: 'input',
                content: 'steer note',
                whenBusy: 'steer',
                requestId: 'steer',
            },
            th.context
        )
        const follow = await childConversation!.submit(
            {
                type: 'input',
                content: 'follow up',
                whenBusy: 'followUp',
                requestId: 'follow',
            },
            th.context
        )

        for (const requestId of ['orig', 'steer', 'follow'] as const) {
            await createReporterTask(th, {
                childPath: '/root/child',
                childId: child.conversationId,
                parentPath: '/root',
                parentId: root.id,
                content: formatEnvelope(
                    'NEW_TASK',
                    'child',
                    '/root',
                    requestId
                ),
                whenBusy: 'steer',
                childRequestId: requestId,
            })
        }

        releaseHold()

        const settledOriginal = await original.wait(th.context)
        const settledSteer = await steer.wait(th.context)
        const settledFollow = await follow.wait(th.context)

        assert.equal(settledOriginal.status, 'done')
        assert.equal(settledSteer.status, 'done')
        assert.equal(settledFollow.status, 'done')
        assert.ok(
            settledOriginal.type === 'input' && settledSteer.type === 'input'
        )
        assert.ok(settledFollow.type === 'input')
        assert.equal(
            settledSteer.answer,
            settledOriginal.answer,
            'the steer must join the held run and share its answer'
        )
        assert.notEqual(
            settledSteer.entry,
            settledOriginal.entry,
            'original and steer are separate placed entries'
        )
        assert.notEqual(
            settledFollow.answer,
            settledOriginal.answer,
            'the followUp must produce a distinct later answer'
        )

        await until(async () => {
            const messages = (await root.context(th.context)).messages
            return (
                messages.filter(
                    (message) =>
                        message.role === 'user' &&
                        messageText(message).startsWith(
                            'Message Type: FINAL_ANSWER'
                        )
                ).length === 2
            )
        })
        await th.harness.waitForIdle(th.context)

        const reports = (await root.context(th.context)).messages.filter(
            (message) =>
                message.role === 'user' &&
                messageText(message).startsWith('Message Type: FINAL_ANSWER')
        )
        assert.equal(
            reports.length,
            2,
            'two distinct answers produce exactly two parent reports'
        )
    } finally {
        releaseHold()
        await th.harness.close(th.context)
    }
})

function messageText(message: { readonly content: unknown }): string {
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
