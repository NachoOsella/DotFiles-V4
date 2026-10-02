/**
 * Provider request gate.
 *
 * Uses the real limiter and real faux provider. The end-to-end case opens a
 * real Harness so the gate sits exactly where a host puts it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
} from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import {
    ExecutionLimiter,
    limitModels,
} from '../src/runtime/execution-limiter.js'

const user = (text: string) => ({
    role: 'user' as const,
    content: text,
    timestamp: 0,
})

test('a pending acquire rejects on abort without consuming capacity', async () => {
    const limiter = new ExecutionLimiter(1)
    const held = await limiter.acquire(undefined)
    assert.equal(limiter.active, 1)
    const controller = new AbortController()
    const pending = limiter.acquire(controller.signal)
    controller.abort(new Error('stop'))
    await assert.rejects(pending, /stop/)
    assert.equal(limiter.active, 1)
    held()
    assert.equal(limiter.active, 0)
})

test('run releases a permit granted just before the caller aborts and never starts', async () => {
    const limiter = new ExecutionLimiter(1)
    const held = await limiter.acquire(undefined)
    const controller = new AbortController()
    let started = false
    const run = limiter.run(controller.signal, async () => {
        started = true
        return 'done'
    })
    held()
    controller.abort(new Error('late'))
    await assert.rejects(run, /late/)
    assert.equal(started, false)
    assert.equal(limiter.active, 0)
})

test('a throwing provider becomes an error event that keeps the model identity', async () => {
    const faux = fauxProvider()
    const model = faux.getModel()
    const throwing = {
        streamSimple() {
            throw new Error('auth missing')
        },
    } as unknown as Models
    const limiter = new ExecutionLimiter(1)
    const stream = limitModels(throwing, limiter).streamSimple(
        model,
        { messages: [user('hi')] },
        undefined
    )
    const events = []
    for await (const event of stream) events.push(event)
    const terminal = events.at(-1)
    assert.equal(terminal?.type, 'error')
    assert.equal(terminal?.reason, 'error')
    assert.equal(terminal?.error.model, model.id)
    assert.equal(terminal?.error.provider, model.provider)
    assert.equal(terminal?.error.stopReason, 'error')
    assert.match(String(terminal?.error.errorMessage), /auth missing/)
    assert.equal(limiter.active, 0)
})

test('the permit is free before the terminal event reaches a consumer', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const limiter = new ExecutionLimiter(1)
    const limited = limitModels(models, limiter)
    const model = faux.getModel()
    faux.setResponses([
        fauxAssistantMessage('first'),
        fauxAssistantMessage('second'),
    ])

    const first = limited.streamSimple(
        model,
        { messages: [user('one')] },
        undefined
    )
    let chained: string | undefined
    for await (const event of first) {
        if (event.type !== 'done') continue
        // The parent starts its next request from the terminal event. With one
        // permit, this deadlocks unless the permit was released before delivery.
        const second = await limited
            .streamSimple(model, { messages: [user('two')] }, undefined)
            .result()
        chained = second.content.find((block) => block.type === 'text')?.text
    }
    assert.equal(chained, 'second')
    assert.equal(limiter.active, 0)
})

test('completeSimple takes and releases one permit', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('summary')])
    const limiter = new ExecutionLimiter(1)
    const limited = limitModels(models, limiter)
    const result = await limited.completeSimple(
        faux.getModel(),
        { messages: [user('summarize')] },
        undefined
    )
    assert.equal(result.content[0]?.type, 'text')
    assert.equal(limiter.active, 0)
})

test('generation through a real Harness uses the wrapped collection and frees capacity', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('answer')])
    const limiter = new ExecutionLimiter(1)
    const harness = await Harness.open(
        new MemoryStorage(),
        { models: limitModels(models, limiter), registry: createRegistry() },
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
        const submission = await root.submit(
            { type: 'input', content: 'hi' },
            BACKGROUND_CONTEXT
        )
        const settled = await submission.wait(BACKGROUND_CONTEXT)
        assert.equal(settled.status, 'done')
        assert.equal(limiter.active, 0)
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})
