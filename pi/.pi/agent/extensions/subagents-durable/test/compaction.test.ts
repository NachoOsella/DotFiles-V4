/**
 * Native compaction.
 *
 * A manual, conversation-owned compaction places its summary through a write
 * submission. Storage keeps the pre-compaction history; addressing and forking
 * continue after the summary head is in effect.
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
import type { HarnessSettings } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'

const settings: HarnessSettings = {
    compaction: {
        enabled: false,
        reserveTokens: 100,
        keepRecentTokens: 1,
        backgroundTokens: 0,
    },
}

test('manual compaction places a head and the conversation stays addressable and forkable', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry: createRegistry(), settings },
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
            assert.equal(
                (await submission.wait(BACKGROUND_CONTEXT)).status,
                'done'
            )
        }

        faux.appendResponses([
            fauxAssistantMessage('## Goal\ncontinue the work'),
        ])
        const taskId = await root.compact(
            'focus on the goal',
            BACKGROUND_CONTEXT
        )
        const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT)
        assert.equal(settled.state.status, 'terminal')
        assert.equal(settled.state.outcome.status, 'completed')
        const result =
            settled.state.outcome.status === 'completed'
                ? settled.state.outcome.result
                : undefined
        assert.ok(
            result?.submissionId !== undefined,
            'conversation-owned compaction places a write submission'
        )
        const placed = await (
            await harness.submission(result.submissionId, BACKGROUND_CONTEXT)
        )?.wait(BACKGROUND_CONTEXT)
        assert.equal(placed?.status, 'done')

        const context = await root.context(BACKGROUND_CONTEXT)
        assert.equal(context.head?.kind, 'pi.compaction')
        const entries = await root.entries(
            {},
            100,
            undefined,
            BACKGROUND_CONTEXT
        )
        assert.ok(
            entries.items.length > context.entries.length,
            'storage keeps pre-compaction entries'
        )

        const tail = entries.items[0]?.id
        assert.ok(tail !== undefined)
        const fork = await root.fork(
            tail,
            { ownership: { kind: 'ownerless' } },
            BACKGROUND_CONTEXT
        )
        faux.appendResponses([fauxAssistantMessage('after fork')])
        const submission = await fork.submit(
            { type: 'input', content: 'continue' },
            BACKGROUND_CONTEXT
        )
        assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done')
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})
