/**
 * Native fork selection.
 *
 * `selectFork` picks the current tail and native omission edits, because a
 * recent-N suffix cannot be expressed by an older prefix fork point alone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
} from '@earendil-works/pi-ai'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { selectFork } from '../src/runtime/forks.js'

async function seededRoot() {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT
    )
    const root = await harness.root(BACKGROUND_CONTEXT)
    await root.configure(
        {
            model: {
                provider: faux.getModel().provider,
                modelId: faux.getModel().id,
            },
        },
        BACKGROUND_CONTEXT
    )
    harness.resume()
    faux.appendResponses([
        fauxAssistantMessage('answer one'),
        fauxAssistantMessage('answer two'),
        fauxAssistantMessage('answer three'),
    ])
    for (const question of ['one', 'two', 'three']) {
        const submission = await root.submit(
            { type: 'input', content: question },
            BACKGROUND_CONTEXT
        )
        assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done')
    }
    return { harness, root }
}

test('recent N selects the tail and omits older active turns', async () => {
    const { harness, root } = await seededRoot()
    try {
        const all = await harness.commit(
            (tx) => selectFork(tx, root.id, 'all'),
            BACKGROUND_CONTEXT
        )
        const tail = (await root.entries({}, 1, undefined, BACKGROUND_CONTEXT))
            .items[0]?.id
        assert.equal(all.at, tail)
        assert.deepEqual(all.edits, [])

        const none = await harness.commit(
            (tx) => selectFork(tx, root.id, 'none'),
            BACKGROUND_CONTEXT
        )
        assert.equal(none.at, undefined)
        assert.deepEqual(none.edits, [])

        const recent = await harness.commit(
            (tx) => selectFork(tx, root.id, '1'),
            BACKGROUND_CONTEXT
        )
        assert.equal(recent.at, tail)
        assert.ok(recent.edits.length > 0, 'older entries are omitted')
        assert.ok(
            recent.edits.every(
                (edit) => edit.action === 'omit' && edit.target < (tail ?? 0)
            ),
            'every edit targets an older entry'
        )
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})

test('a recent-N fork keeps only the newest turn in model context', async () => {
    const { harness, root } = await seededRoot()
    try {
        const childId = await harness.commit(async (tx) => {
            const selection = await selectFork(tx, root.id, '1')
            assert.ok(selection.at !== undefined)
            const child = await tx.forkConversation(root.id, selection.at, {
                ownership: { kind: 'ownerless' },
            })
            await tx.appendEntry(child.id, {
                kind: 'pi.user',
                model: [{ role: 'user', content: 'continue', timestamp: 0 }],
                edits: selection.edits,
            })
            return child.id
        }, BACKGROUND_CONTEXT)
        const child = await harness.conversation(childId, BACKGROUND_CONTEXT)
        assert.ok(child)
        const context = await child.context(BACKGROUND_CONTEXT)
        const text = context.messages
            .map((message) =>
                message.role === 'user' && typeof message.content === 'string'
                    ? message.content
                    : ''
            )
            .join('\n')
        assert.doesNotMatch(text, /\bone\b/)
        assert.doesNotMatch(text, /\btwo\b/)
        assert.match(text, /\bthree\b/)
        assert.match(text, /continue/)
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})
