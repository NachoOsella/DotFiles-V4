/**
 * Native usage.
 *
 * Usage comes only from `pi.usage`; a fork starts with the document's initial
 * value, so inherited history never double counts.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
} from '@earendil-works/pi-ai'
import { Harness, UsageDoc, createRegistry } from '@earendil-works/pi-durable'
import type { UsageState } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'

function tokens(usage: UsageState | undefined): number {
    if (usage === undefined) return 0
    let total = 0
    for (const bucket of [usage.models, usage.tools]) {
        for (const value of Object.values(bucket)) total += value.totalTokens
    }
    return total
}

test('usage stays per conversation and a fork starts without inherited spend', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT
    )
    try {
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

        faux.appendResponses([fauxAssistantMessage('first answer')])
        const first = await root.submit(
            { type: 'input', content: 'first question' },
            BACKGROUND_CONTEXT
        )
        await first.wait(BACKGROUND_CONTEXT)
        const rootTokens = tokens(
            await harness.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT)
        )
        assert.ok(rootTokens > 0, 'the root records its own spend')

        const tail = (await root.entries({}, 1, undefined, BACKGROUND_CONTEXT))
            .items[0]?.id
        assert.ok(tail !== undefined)
        const fork = await root.fork(
            tail,
            { ownership: { kind: 'ownerless' } },
            BACKGROUND_CONTEXT
        )
        assert.equal(
            tokens(
                await harness.snapshot(UsageDoc, fork.id, BACKGROUND_CONTEXT)
            ),
            0
        )
        assert.equal(
            tokens(
                await harness.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT)
            ),
            rootTokens,
            'forking does not change the parent ledger'
        )

        const child = await harness.createConversation(
            { ownership: { kind: 'ownerless' } },
            BACKGROUND_CONTEXT
        )
        await child.configure(
            {
                model: {
                    provider: faux.getModel().provider,
                    modelId: faux.getModel().id,
                },
            },
            BACKGROUND_CONTEXT
        )
        faux.appendResponses([fauxAssistantMessage('child answer')])
        const childSubmission = await child.submit(
            { type: 'input', content: 'child question' },
            BACKGROUND_CONTEXT
        )
        await childSubmission.wait(BACKGROUND_CONTEXT)
        const childTokens = tokens(
            await harness.snapshot(UsageDoc, child.id, BACKGROUND_CONTEXT)
        )
        assert.ok(childTokens > 0)

        const aggregate = await harness.usage(BACKGROUND_CONTEXT)
        assert.equal(
            aggregate.models[
                `${faux.getModel().provider}/${faux.getModel().id}`
            ]?.totalTokens,
            rootTokens + childTokens
        )
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})
