/**
 * Durable 1.0.0 API assumptions the native extension relies on.
 *
 * These are boundary tests against the real Harness, not extension-source
 * assertions: passive writes, request-id deduplication, native omission edits,
 * and the inert legacy entry point.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { EntryDraft } from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import {
    createSubagentsExtension,
    type PassiveWriter,
} from '../src/extension.js'
import { createTestHarness } from '../src/testing/index.js'
import subagentsDurableExtension from '../index.js'

function assistant(text: string): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'openai-responses',
        provider: 'test',
        model: 'test-model',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: 'stop',
        timestamp: 0,
    } as AssistantMessage
}

test('the legacy coding-agent entry point registers nothing', () => {
    assert.equal(typeof subagentsDurableExtension, 'function')
    const reads: string[] = []
    const fakePi = new Proxy(
        {},
        {
            get: (_target, property) => {
                reads.push(String(property))
                return () => undefined
            },
        }
    )
    ;(subagentsDurableExtension as (pi: unknown) => void)(fakePi)
    assert.deepEqual(reads, [])
})

test('a disabled config registers no tools but keeps task definitions', () => {
    const submitWrite: PassiveWriter = async () => {
        throw new Error('disabled extension must not write')
    }
    const extension = createSubagentsExtension({
        config: { ...DEFAULT_CONFIG, enabled: false },
        submitWrite,
    })
    assert.deepEqual(extension.tools ?? [], [])
    assert.equal(extension.tasks?.length, 2)
})

test('a disabled native extension offers no collaboration tools', async () => {
    const submitWrite: PassiveWriter = async () => {
        throw new Error('disabled extension must not write')
    }
    const extension = createSubagentsExtension({
        config: { ...DEFAULT_CONFIG, enabled: false },
        submitWrite,
    })
    const harness = await createTestHarness({
        extensions: [extension],
    })
    try {
        const root = await harness.harness.root(harness.context)
        const agent = await root.agent(harness.context)
        assert.ok(
            !agent.tools.some((tool) => tool.name === 'spawn_agent'),
            'no spawn_agent is offered'
        )
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('passive writes never start a run and deduplicate by requestId', async () => {
    const harness = await createTestHarness()
    try {
        const root = await harness.harness.root(harness.context)
        await root.configure(
            { model: { provider: harness.provider, modelId: harness.modelId } },
            harness.context
        )
        harness.faux!.setResponses([fauxAssistantMessage('must not run')])
        const draft = {
            type: 'write' as const,
            requestId: 'write-1',
            entry: {
                kind: 'pi.user',
                model: [
                    {
                        role: 'user' as const,
                        content: 'passive note',
                        timestamp: 0,
                    },
                ],
            },
        }
        const first = await root.submit(draft, harness.context)
        const settled = await first.wait(harness.context)
        assert.equal(settled.status, 'done')
        assert.equal(
            harness.faux!.getPendingResponseCount(),
            1,
            'a passive write starts no model request'
        )

        const again = await root.submit(draft, harness.context)
        assert.equal(
            again.id,
            first.id,
            'requestId deduplicates the submission'
        )

        const view = await root.context(harness.context)
        assert.match(JSON.stringify(view.messages), /passive note/)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('native omission edits remove inherited contributions in a fork', async () => {
    const harness = await createTestHarness()
    try {
        const { harness: api, context } = harness
        const root = await api.root(context)
        const oldUser = await api.commit(
            (tx) =>
                tx.appendEntry(root.id, {
                    kind: 'pi.user',
                    model: [
                        {
                            role: 'user' as const,
                            content: 'old inherited',
                            timestamp: 0,
                        },
                    ],
                }),
            context
        )
        await api.commit(
            (tx) =>
                tx.appendEntry(root.id, {
                    kind: 'pi.assistant',
                    model: [assistant('old answer')],
                }),
            context
        )
        await api.commit(
            (tx) =>
                tx.appendEntry(root.id, {
                    kind: 'pi.user',
                    model: [
                        {
                            role: 'user' as const,
                            content: 'recent inherited',
                            timestamp: 0,
                        },
                    ],
                }),
            context
        )
        const tail = await api.commit(
            (tx) =>
                tx.appendEntry(root.id, {
                    kind: 'pi.assistant',
                    model: [assistant('recent answer')],
                }),
            context
        )
        const child = await api.commit(
            (tx) =>
                tx.forkConversation(root.id, tail.id, {
                    ownership: { kind: 'ownerless' },
                }),
            context
        )
        const edit: EntryDraft = {
            kind: 'subagents.fork-edit',
            edits: [{ target: oldUser.id, action: 'omit' }],
        }
        await api.commit((tx) => tx.appendEntry(child.id, edit), context)

        const childConversation = await api.conversation(child.id, context)
        assert.ok(childConversation)
        const view = await childConversation.context(context)
        const text = JSON.stringify(view.messages)
        assert.doesNotMatch(text, /old inherited/)
        assert.match(text, /recent inherited/)
    } finally {
        await harness.harness.close(harness.context)
    }
})
