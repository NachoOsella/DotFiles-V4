/**
 * Core integration tests for the native tools.
 *
 * These drive the real public Harness over MemoryStorage with a scripted faux
 * provider. Each model turn calls the real registered tool, so the durable
 * commits, task scheduling, request IDs, and document writes are all the
 * production code paths.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type {
    AssistantMessage,
    FauxResponseFactory,
    FauxResponseStep,
} from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'
import { createAgentConversation } from '../src/testing/index.js'
import {
    configureRoot,
    createCoreHarness,
    lastUserText,
    until,
    waitForEnvelope,
} from './support.js'

type RequestContext = Parameters<FauxResponseFactory>[0]

function route(
    handler: (text: string, request: RequestContext) => AssistantMessage
): FauxResponseFactory {
    return (request: RequestContext): AssistantMessage =>
        handler(lastUserText(request.messages), request)
}

function script(responses: FauxResponseStep[], times = 40): FauxResponseStep[] {
    return Array.from(
        { length: times },
        (_, index) => responses[index % responses.length]!
    )
}

function answerText(text: string): AssistantMessage {
    return fauxAssistantMessage(text)
}

function callTool(
    name: string,
    args: JsonObject,
    id: string
): AssistantMessage {
    return fauxAssistantMessage([fauxToolCall(name, args, { id })], {
        stopReason: 'toolUse',
    })
}

test('spawn creates a canonical child and a child MESSAGE write reaches root', async () => {
    const th = await createCoreHarness()
    try {
        const root = await configureRoot(th)
        th.faux!.setResponses(
            script([
                route((text) => {
                    if (text.includes('"delivered":true')) {
                        return answerText('child answer')
                    }
                    if (text.includes('"task_name"')) {
                        return answerText('parent done')
                    }
                    if (text.includes('Message Type: FINAL_ANSWER')) {
                        return answerText('ack')
                    }
                    if (
                        text.startsWith('Message Type: NEW_TASK') &&
                        text.includes('Task name: child')
                    ) {
                        return callTool(
                            'send_message',
                            { target: '/root', message: 'hello root' },
                            'send-1'
                        )
                    }
                    if (text.includes('start work')) {
                        return callTool(
                            'spawn_agent',
                            { task_name: 'child', message: 'do it' },
                            'spawn-1'
                        )
                    }
                    return answerText('idle')
                }),
            ])
        )
        const submission = await root.submit(
            { type: 'input', content: 'start work' },
            th.context
        )
        await submission.wait(th.context)
        await waitForEnvelope(th, root)

        const state = await th.harness.snapshot(SubagentsDoc, th.context)
        const child = state?.agents['/root/child']
        assert.ok(child, 'the child must be registered by canonical path')
        assert.equal(child.parentPath, '/root')

        const rootMessages = (await root.context(th.context)).messages
        assert.ok(
            rootMessages.some(
                (message) =>
                    message.role === 'user' &&
                    textOf(message).startsWith('Message Type: MESSAGE')
            ),
            'child MESSAGE must be written to root as an envelope'
        )
        assert.ok(
            rootMessages.some(
                (message) =>
                    message.role === 'user' &&
                    textOf(message).startsWith('Message Type: FINAL_ANSWER')
            ),
            'the reporter must deliver one FINAL_ANSWER to root'
        )

        const childConversation = await th.harness.conversation(
            child.conversationId,
            th.context
        )
        const childMessages = (await childConversation!.context(th.context))
            .messages
        assert.ok(
            childMessages.some(
                (message) =>
                    message.role === 'assistant' &&
                    textOf(message).includes('child answer')
            ),
            'the child must answer through a real generation'
        )
    } finally {
        await th.harness.close(th.context)
    }
})

test('followup_task steers an existing child and reports its answer', async () => {
    const th = await createCoreHarness()
    try {
        const root = await configureRoot(th)
        await createAgentConversation(th, {
            path: '/root/child',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        th.faux!.setResponses(
            script([
                route((text) => {
                    if (text.includes('Message Type: FINAL_ANSWER')) {
                        return answerText('ack')
                    }
                    if (
                        text.startsWith('Message Type: NEW_TASK') &&
                        text.includes('Task name: child')
                    ) {
                        return answerText('followed answer')
                    }
                    if (text.includes('follow it')) {
                        return callTool(
                            'followup_task',
                            { target: '/root/child', message: 'more' },
                            'follow-1'
                        )
                    }
                    return answerText('parent done')
                }),
            ])
        )
        const submission = await root.submit(
            { type: 'input', content: 'follow it' },
            th.context
        )
        await submission.wait(th.context)
        await waitForEnvelope(th, root)

        const rootMessages = (await root.context(th.context)).messages
        assert.ok(
            rootMessages.some(
                (message) =>
                    message.role === 'user' &&
                    textOf(message).includes('followed answer')
            ),
            'the child answer must be reported to the parent'
        )
    } finally {
        await th.harness.close(th.context)
    }
})

test('wait_agent times out without starting child work', async () => {
    const config = {
        ...DEFAULT_CONFIG,
        wait: { defaultTimeoutMs: 40, minTimeoutMs: 0, maxTimeoutMs: 1000 },
    }
    const th = await createCoreHarness(config)
    try {
        const root = await configureRoot(th)
        th.faux!.setResponses(
            script([
                route((text) => {
                    if (text.includes('timed out')) {
                        return answerText('done')
                    }
                    if (text.includes('wait it')) {
                        return callTool(
                            'wait_agent',
                            { timeout_ms: 40 },
                            'wait-1'
                        )
                    }
                    return answerText('idle')
                }),
            ])
        )
        const submission = await root.submit(
            { type: 'input', content: 'wait it' },
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
            'wait_agent must report a timeout'
        )
    } finally {
        await th.harness.close(th.context)
    }
})

test('logical capacity rejects a second spawn without creating a second child', async () => {
    const config = { ...DEFAULT_CONFIG, maxAgents: 1 }
    const th = await createCoreHarness(config)
    try {
        const root = await configureRoot(th)
        th.faux!.setResponses(
            script([
                route((text) => {
                    if (text.includes('capacity')) {
                        return answerText('parent done')
                    }
                    if (text.includes('"task_name":"/root/a"')) {
                        return callTool(
                            'spawn_agent',
                            { task_name: 'b', message: 'second' },
                            'spawn-b'
                        )
                    }
                    if (text.includes('spawn two')) {
                        return callTool(
                            'spawn_agent',
                            { task_name: 'a', message: 'first' },
                            'spawn-a'
                        )
                    }
                    return answerText('idle')
                }),
            ])
        )
        const submission = await root.submit(
            { type: 'input', content: 'spawn two' },
            th.context
        )
        await submission.wait(th.context)
        await until(async () => {
            const messages = (await root.context(th.context)).messages
            return messages.some(
                (message) =>
                    message.role === 'toolResult' &&
                    message.isError === true &&
                    textOf(message).includes('capacity')
            )
        })
        const state = await th.harness.snapshot(SubagentsDoc, th.context)
        assert.equal(Object.keys(state?.agents ?? {}).length, 1)
    } finally {
        await th.harness.close(th.context)
    }
})

test('a wait timeout cancels only observation; the child still finishes', async () => {
    const config = {
        ...DEFAULT_CONFIG,
        wait: { defaultTimeoutMs: 40, minTimeoutMs: 0, maxTimeoutMs: 1000 },
    }
    const th = await createCoreHarness(config)
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
        th.faux!.setResponses(
            script([
                async (request) => {
                    const text = lastUserText(request.messages)
                    if (text.includes('gated work')) {
                        gateStarted()
                        await gate
                        return fauxAssistantMessage('gated answer')
                    }
                    if (text.includes('timed out')) return answerText('done')
                    if (text.includes('wait it')) {
                        return callTool(
                            'wait_agent',
                            { targets: ['/root/child'], timeout_ms: 40 },
                            'wait-1'
                        )
                    }
                    return answerText('idle')
                },
            ])
        )
        const childHandle = await th.harness.conversation(
            child.conversationId,
            th.context
        )
        await childHandle!.submit(
            { type: 'input', content: 'gated work' },
            th.context
        )
        await started
        const submission = await root.submit(
            { type: 'input', content: 'wait it' },
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
            'the wait must time out while the child is held'
        )
        releaseGate()
        await until(async () => {
            const childView = await (await th.harness.conversation(
                child.conversationId,
                th.context
            ))!.context(th.context)
            return childView.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    textOf(message).includes('gated answer')
            )
        })
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
