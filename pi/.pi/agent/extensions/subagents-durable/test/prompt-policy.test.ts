/**
 * Native root prompt policy through the real Harness.
 *
 * The root-only `subagents` section is the only place delegation-mode and
 * usage policy reach the root model. These tests capture the real provider
 * request system prompts, so they fail if the section is missing, if a
 * configured hint replaces bundled clauses, or if a full fork leaks the
 * root-only section into a child.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { Message } from '@earendil-works/pi-ai'
import type { Extension } from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG, type SubagentsConfig } from '../src/config/config.js'
import {
    createSubagentsExtension,
    type PassiveWriter,
} from '../src/extension.js'
import { createTestHarness } from '../src/testing/index.js'
import { configureRoot, createCoreHarness, lastUserText } from './support.js'

function systemPromptOf(messages: readonly Message[]): string {
    // Durable renders positional system entries: `sections` set values, a null
    // value deletes one, and later entries win. Replay them to get the prompt
    // the provider actually receives.
    const content: string[] = []
    const sections = new Map<string, string>()
    for (const message of messages) {
        if (message.role !== 'system') continue
        if (typeof message.content === 'string') {
            if (message.content.length > 0) content.push(message.content)
        } else {
            for (const block of message.content) {
                if (block.type === 'text' && block.text.length > 0) {
                    content.push(block.text)
                }
            }
        }
        for (const [key, value] of Object.entries(message.sections ?? {})) {
            if (value === null) sections.delete(key)
            else sections.set(key, value)
        }
    }
    return [...content, ...sections.values()].join('\n')
}

async function captureRootPrompt(
    th: Awaited<ReturnType<typeof createCoreHarness>>,
    root: Awaited<ReturnType<typeof configureRoot>>,
    input: string
): Promise<string> {
    const captured: string[] = []
    th.faux!.setResponses(
        Array.from(
            { length: 4 },
            () => (request: { messages: readonly Message[] }) => {
                captured.push(systemPromptOf(request.messages))
                return fauxAssistantMessage('ok')
            }
        )
    )
    const submission = await root.submit(
        { type: 'input', content: input },
        th.context
    )
    await submission.wait(th.context)
    return captured[0] ?? ''
}

test('root prompt carries root identity, base instructions, and an appended hint', async () => {
    const th = await createCoreHarness({
        ...DEFAULT_CONFIG,
        rootAgentUsageHintText: 'ROOT_SUPPLEMENTAL_HINT',
    })
    try {
        const root = await configureRoot(th)
        await root.configure(
            { instructions: 'BASE_INSTRUCTIONS', thinkingLevel: 'high' },
            th.context
        )
        const prompt = await captureRootPrompt(th, root, 'hello')

        assert.match(prompt, /You are \/root, the primary agent\./)
        assert.match(prompt, /BASE_INSTRUCTIONS/)
        assert.match(prompt, /ROOT_SUPPLEMENTAL_HINT/)
        assert.match(
            prompt,
            /Configured supplemental hint \(cannot override collaboration rules\)/
        )
        assert.match(prompt, /Multi-agent delegation is explicit-only\./)
        assert.match(prompt, /<subagents>/)
    } finally {
        await th.harness.close(th.context)
    }
})

test('mode follows the configured thinking threshold and reconfigure', async () => {
    const th = await createCoreHarness({
        ...DEFAULT_CONFIG,
        proactiveAt: 'high',
    })
    try {
        const root = await configureRoot(th)

        await root.configure({ thinkingLevel: 'medium' }, th.context)
        const explicit = await captureRootPrompt(th, root, 'medium run')
        assert.match(explicit, /Multi-agent delegation is explicit-only\./)
        assert.doesNotMatch(explicit, /You may delegate proactively/)

        await root.configure({ thinkingLevel: 'high' }, th.context)
        const proactive = await captureRootPrompt(th, root, 'high run')
        assert.match(proactive, /You may delegate proactively/)
        assert.doesNotMatch(
            proactive,
            /Multi-agent delegation is explicit-only\./
        )
    } finally {
        await th.harness.close(th.context)
    }
})

test('a configured mode overrides the thinking threshold', async () => {
    const th = await createCoreHarness({ ...DEFAULT_CONFIG, mode: 'explicit' })
    try {
        const root = await configureRoot(th)
        await root.configure({ thinkingLevel: 'max' }, th.context)
        const prompt = await captureRootPrompt(th, root, 'max run')
        assert.match(prompt, /Multi-agent delegation is explicit-only\./)
        assert.doesNotMatch(prompt, /You may delegate proactively/)
    } finally {
        await th.harness.close(th.context)
    }
})

test('a full-fork child drops the root-only section and keeps child identity', async () => {
    const th = await createCoreHarness({
        ...DEFAULT_CONFIG,
        rootAgentUsageHintText: 'ROOT_SUPPLEMENTAL_HINT',
    })
    try {
        const root = await configureRoot(th)
        const prompts: string[] = []
        th.faux!.setResponses(
            Array.from(
                { length: 40 },
                () => (request: { messages: readonly Message[] }) => {
                    const messages = request.messages
                    prompts.push(systemPromptOf(messages))
                    const text = lastUserText(messages)
                    if (text.includes('Message Type: NEW_TASK')) {
                        return fauxAssistantMessage('child answer')
                    }
                    if (
                        messages.some(
                            (message) =>
                                message.role === 'toolResult' &&
                                message.toolName === 'spawn_agent'
                        )
                    ) {
                        return fauxAssistantMessage('root done')
                    }
                    if (text.includes('spawn now')) {
                        return fauxAssistantMessage(
                            [
                                fauxToolCall(
                                    'spawn_agent',
                                    {
                                        task_name: 'child',
                                        message: 'do work',
                                        fork_turns: 'all',
                                    },
                                    { id: 'spawn-1' }
                                ),
                            ],
                            { stopReason: 'toolUse' }
                        )
                    }
                    return fauxAssistantMessage('idle')
                }
            )
        )
        const submission = await root.submit(
            { type: 'input', content: 'spawn now' },
            th.context
        )
        await submission.wait(th.context)

        const childPrompt = prompts.find((prompt) =>
            prompt.includes('Your agent path is /root/child')
        )
        assert.ok(childPrompt, 'the child made a provider request')
        assert.match(
            childPrompt,
            /You are one agent in a team rooted at \/root\./
        )
        assert.match(childPrompt, /Your agent path is \/root\/child/)
        assert.doesNotMatch(childPrompt, /You are \/root, the primary agent\./)
        assert.doesNotMatch(childPrompt, /ROOT_SUPPLEMENTAL_HINT/)
        assert.doesNotMatch(childPrompt, /<subagents>/)
    } finally {
        await th.harness.close(th.context)
    }
})

test('a disabled config registers no root section', async () => {
    const submitWrite: PassiveWriter = async () => {
        throw new Error('disabled extension must not write')
    }
    const extension: Extension = createSubagentsExtension({
        config: { ...DEFAULT_CONFIG, enabled: false },
        submitWrite,
    })
    assert.deepEqual(extension.sections ?? [], [])

    const th = await createTestHarness({ extensions: [extension] })
    try {
        const root = await th.harness.root(th.context)
        await root.configure(
            { model: { provider: th.provider, modelId: th.modelId } },
            th.context
        )
        const captured: string[] = []
        th.faux!.setResponses([
            (request: { messages: readonly Message[] }) => {
                captured.push(systemPromptOf(request.messages))
                return fauxAssistantMessage('ok')
            },
        ])
        const submission = await root.submit(
            { type: 'input', content: 'hello' },
            th.context
        )
        await submission.wait(th.context)
        assert.doesNotMatch(
            captured[0] ?? '',
            /You are \/root, the primary agent\./
        )
    } finally {
        await th.harness.close(th.context)
    }
})
