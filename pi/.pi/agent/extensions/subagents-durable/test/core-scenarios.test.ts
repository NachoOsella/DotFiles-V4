/**
 * Cross-tool scenarios: a queued report waking a default wait without being
 * consumed, and interruption that preserves identity for a later followup.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import { LiveDoc } from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG, type SubagentsConfig } from '../src/config/config.js'
import { formatEnvelope } from '../src/domain/communication.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'
import {
    abortRejection,
    createAgentConversation,
    createReporterTask,
} from '../src/testing/index.js'
import {
    configureRoot,
    createCoreHarness,
    lastUserText,
    until,
    waitForEnvelope,
} from './support.js'

type RequestContext = Parameters<FauxResponseFactory>[0]
type Options = Parameters<FauxResponseFactory>[1]

function toolCall(
    name: string,
    args: Record<string, unknown>,
    id: string
): ReturnType<typeof fauxAssistantMessage> {
    return fauxAssistantMessage([fauxToolCall(name, args as never, { id })], {
        stopReason: 'toolUse',
    })
}

const shortWait: SubagentsConfig = {
    ...DEFAULT_CONFIG,
    wait: { defaultTimeoutMs: 3000, minTimeoutMs: 0, maxTimeoutMs: 5000 },
}

test('default wait wakes on a queued report and does not consume it', async () => {
    const th = await createCoreHarness(shortWait)
    try {
        const root = await configureRoot(th)
        const child = await createAgentConversation(th, {
            path: '/root/child',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        let releaseGate!: () => void
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve
        })
        let gateStarted!: () => void
        const started = new Promise<void>((resolve) => {
            gateStarted = resolve
        })
        const factory: FauxResponseFactory = async (
            request: RequestContext,
            options: Options
        ) => {
            const text = lastUserText(request.messages)
            if (text.includes('gated work')) {
                gateStarted()
                await Promise.race([gate, abortRejection(options?.signal)])
                return fauxAssistantMessage('child answer')
            }
            if (text.includes('Message Type: FINAL_ANSWER')) {
                return fauxAssistantMessage('ack')
            }
            if (text.includes('Wait completed.')) {
                return fauxAssistantMessage('done')
            }
            if (text.includes('wait here')) {
                return toolCall('wait_agent', { timeout_ms: 3000 }, 'wait-1')
            }
            return fauxAssistantMessage('idle')
        }
        th.faux!.setResponses(Array.from({ length: 30 }, () => factory))

        await createReporterTask(th, {
            childPath: '/root/child',
            childId: child.conversationId,
            parentPath: '/root',
            parentId: root.id,
            content: formatEnvelope('NEW_TASK', 'child', '/root', 'gated work'),
            whenBusy: 'followUp',
        })
        await started
        const submission = await root.submit(
            { type: 'input', content: 'wait here' },
            th.context
        )
        await until(async () => {
            const live = await th.harness.snapshot(LiveDoc, root.id, th.context)
            return (
                live?.tools?.some(
                    (slot) =>
                        slot.name === 'wait_agent' && slot.status === 'running'
                ) === true
            )
        })
        releaseGate()
        await submission.wait(th.context)
        await waitForEnvelope(th, root)

        const messages = (await root.context(th.context)).messages
        assert.ok(
            messages.some(
                (message) =>
                    message.role === 'toolResult' &&
                    textOf(message).includes('Wait completed.')
            ),
            'the default wait must wake on the queued report'
        )
        assert.ok(
            messages.some(
                (message) =>
                    message.role === 'user' &&
                    textOf(message).startsWith('Message Type: FINAL_ANSWER')
            ),
            'the report must remain and be placed, not consumed by the wait'
        )
    } finally {
        await th.harness.close(th.context)
    }
})

test('interrupt preserves identity and a later followup still answers', async () => {
    const th = await createCoreHarness(shortWait)
    try {
        const root = await configureRoot(th)
        const child = await createAgentConversation(th, {
            path: '/root/child',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        let gateStarted!: () => void
        const started = new Promise<void>((resolve) => {
            gateStarted = resolve
        })
        const factory: FauxResponseFactory = async (
            request: RequestContext,
            options: Options
        ) => {
            const text = lastUserText(request.messages)
            if (text.includes('gated work')) {
                gateStarted()
                await abortRejection(options?.signal)
                return fauxAssistantMessage('never')
            }
            if (text.includes('Message Type: FINAL_ANSWER')) {
                return fauxAssistantMessage('ack')
            }
            if (
                text.startsWith('Message Type: NEW_TASK') &&
                text.includes('Task name: child')
            ) {
                return fauxAssistantMessage('later answer')
            }
            if (text.includes('interrupt it')) {
                return toolCall(
                    'interrupt_agent',
                    { target: '/root/child' },
                    'int-1'
                )
            }
            if (text.includes('follow up')) {
                return toolCall(
                    'followup_task',
                    { target: '/root/child', message: 'more' },
                    'fol-1'
                )
            }
            return fauxAssistantMessage('done')
        }
        th.faux!.setResponses(Array.from({ length: 30 }, () => factory))

        const childHandle = await th.harness.conversation(
            child.conversationId,
            th.context
        )
        await childHandle!.submit(
            { type: 'input', content: 'gated work' },
            th.context
        )
        await started

        const interruptRun = await root.submit(
            { type: 'input', content: 'interrupt it' },
            th.context
        )
        await interruptRun.wait(th.context)

        const stateAfter = await th.harness.snapshot(SubagentsDoc, th.context)
        assert.ok(
            stateAfter?.agents['/root/child'],
            'interruption must preserve the child identity'
        )

        const followupRun = await root.submit(
            { type: 'input', content: 'follow up' },
            th.context
        )
        await followupRun.wait(th.context)
        await waitForEnvelope(th, root)

        const childView = await (await th.harness.conversation(
            child.conversationId,
            th.context
        ))!.context(th.context)
        assert.ok(
            childView.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    textOf(message).includes('later answer')
            ),
            'a later followup must still run in the same conversation'
        )
    } finally {
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
