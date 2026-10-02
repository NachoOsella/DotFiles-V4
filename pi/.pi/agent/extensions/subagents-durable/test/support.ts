/**
 * Integration test support.
 *
 * Builds the real Durable Harness over real storage with a scripted pi-ai faux
 * provider, installs the native subagents extension, and supplies the one host
 * exception: the public passive-write path.
 */

import type { Message } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
    Conversation,
    Extension,
    Harness,
} from '@earendil-works/pi-durable'
import {
    createSubagentsExtension,
    type PassiveWriter,
} from '../src/extension.js'
import { DEFAULT_CONFIG, type SubagentsConfig } from '../src/config/config.js'
import { createTestHarness, type TestHarness } from '../src/testing/index.js'

export type CoreHarness = TestHarness & {
    readonly extension: Extension
}

export async function createCoreHarness(
    config: SubagentsConfig = DEFAULT_CONFIG,
    extras: readonly Extension[] = []
): Promise<CoreHarness> {
    let harness: Harness | undefined
    const submitWrite: PassiveWriter = async (id, draft, context) => {
        if (harness === undefined) throw new Error('harness is not ready')
        const conversation =
            id === ROOT_CONVERSATION_ID
                ? await harness.root(context)
                : await harness.conversation(id, context)
        if (conversation === undefined) {
            throw new Error(`Conversation ${id} is missing.`)
        }
        return conversation.submit(draft, context)
    }
    const extension = createSubagentsExtension({ config, submitWrite })
    const harnessApi = await createTestHarness({
        extensions: [extension, ...extras],
    })
    harness = harnessApi.harness
    return Object.assign(harnessApi, { extension })
}

export async function configureRoot(th: CoreHarness): Promise<Conversation> {
    const root = await th.harness.root(th.context)
    await root.configure(
        { model: { provider: th.provider, modelId: th.modelId } },
        th.context
    )
    return root
}

/** Text of the newest non-system message in one provider request. */
export function lastUserText(messages: readonly Message[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message === undefined || message.role === 'system') continue
        return messageText(message)
    }
    return ''
}

export function messageText(message: Message): string {
    if (typeof message.content === 'string') return message.content
    const parts: string[] = []
    for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text)
    }
    return parts.join('\n')
}

export async function until(
    check: () => Promise<boolean>,
    timeoutMs = 4000
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        if (await check()) return
        if (Date.now() > deadline) {
            throw new Error('condition was not reached before the timeout')
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

/** Wait until a conversation has a user envelope starting with `marker`, then go idle. */
export async function waitForEnvelope(
    th: CoreHarness,
    conversation: Conversation,
    marker = 'Message Type: FINAL_ANSWER'
): Promise<void> {
    await until(async () => {
        const messages = (await conversation.context(th.context)).messages
        return messages.some(
            (message) =>
                message.role === 'user' &&
                messageText(message).startsWith(marker)
        )
    })
    await th.harness.waitForIdle(th.context)
}
