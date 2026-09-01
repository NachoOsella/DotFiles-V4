import assert from 'node:assert/strict'
import test from 'node:test'
import { Effect } from 'effect'
import { deliverMailbox } from './src/delivery.ts'
import type { ParentDeliveryMessage } from './src/delivery.ts'
import {
    createAgentMailbox,
    type AgentEnvelope,
    type MailboxDrainOptions,
} from './src/mailbox.ts'

function envelope(
    sequence: number,
    kind: AgentEnvelope['kind'],
    runId?: string
): AgentEnvelope {
    return {
        sequence,
        agentId: 'sa-1',
        taskName: 'delivery-test',
        role: 'worker',
        kind,
        runId,
        text: `${kind}-${sequence}`,
        createdAt: sequence,
    }
}

function mailbox(initial: ReadonlyArray<AgentEnvelope>) {
    const pending = [...initial]
    const claimed = new Set<number>()
    const acknowledgements: number[][] = []
    return {
        pending,
        claimed,
        acknowledgements,
        manager: {
            claimMailbox: (options?: MailboxDrainOptions) => {
                const sequences = options?.sequences
                    ? new Set(options.sequences)
                    : undefined
                const events = pending.filter(
                    (event) =>
                        !claimed.has(event.sequence) &&
                        (!sequences || sequences.has(event.sequence))
                )
                for (const event of events) claimed.add(event.sequence)
                return events
            },
            releaseMailbox: (sequences: Iterable<number>) => {
                for (const sequence of sequences) claimed.delete(sequence)
            },
            ackMailbox: (sequences: Iterable<number>) => {
                const acknowledged = [...sequences]
                acknowledgements.push(acknowledged)
                for (const sequence of acknowledged) {
                    claimed.delete(sequence)
                    const index = pending.findIndex(
                        (event) => event.sequence === sequence
                    )
                    if (index >= 0) pending.splice(index, 1)
                }
            },
        },
    }
}

test('parent delivery keeps questions steering and results as follow-ups', async () => {
    const state = mailbox([
        envelope(1, 'result', 'run-1'),
        envelope(2, 'question'),
        envelope(3, 'error', 'run-2'),
    ])
    const modes: string[] = []

    const result = await deliverMailbox(
        state.manager,
        async (_message, options) => {
            modes.push(options.deliverAs)
        },
        new Map()
    )

    assert.deepEqual(modes, ['followUp', 'steer', 'followUp'])
    assert.deepEqual(state.acknowledgements, [[1], [2], [3]])
    assert.deepEqual(result, { delivered: true, retry: false })
})

test('failed asynchronous parent delivery leaves events pending for retry', async () => {
    const state = mailbox([envelope(1, 'result', 'run-1')])
    const attempts = new Map<number, number>()
    let shouldFail = true

    const sender = async () => {
        if (shouldFail) throw new Error('parent is busy')
    }
    const failed = await deliverMailbox(state.manager, sender, attempts)
    assert.deepEqual(failed, {
        delivered: false,
        retry: true,
        retryAfterMs: 250,
    })
    assert.equal(state.pending.length, 1)
    assert.equal(state.acknowledgements.length, 0)

    shouldFail = false
    const delivered = await deliverMailbox(state.manager, sender, attempts)
    assert.deepEqual(delivered, { delivered: true, retry: false })
    assert.equal(state.pending.length, 0)
})

test('delivery stops at the first failed batch and retries in sequence order', async () => {
    const state = mailbox([
        envelope(1, 'result', 'run-1'),
        envelope(2, 'question'),
        envelope(3, 'result', 'run-3'),
    ])
    const attempts = new Map<number, number>()
    const sent: number[] = []
    let failQuestion = true
    const sender = async (message: ParentDeliveryMessage) => {
        const sequence = message.details.events[0]?.sequence
        if (sequence !== undefined) sent.push(sequence)
        if (sequence === 2 && failQuestion) {
            failQuestion = false
            throw new Error('parent unavailable')
        }
    }

    const failed = await deliverMailbox(state.manager, sender, attempts)
    assert.deepEqual(sent, [1, 2])
    assert.equal(failed.retry, true)
    assert.deepEqual(state.pending.map((event) => event.sequence), [2, 3])
    assert.deepEqual(state.claimed, new Set())

    const delivered = await deliverMailbox(state.manager, sender, attempts)
    assert.deepEqual(sent, [1, 2, 2, 3])
    assert.deepEqual(delivered, { delivered: true, retry: false })
    assert.deepEqual(state.pending, [])
})

test('automatic delivery owns an event while the host sender is awaiting', async () => {
    const state = mailbox([envelope(1, 'result', 'run-1')])
    let releaseSender!: () => void
    const sending = deliverMailbox(
        state.manager,
        () => new Promise<void>((resolve) => (releaseSender = resolve)),
        new Map()
    )

    await Promise.resolve()
    assert.deepEqual(state.manager.claimMailbox(), [])
    assert.deepEqual(state.pending, [envelope(1, 'result', 'run-1')])
    releaseSender()
    await sending
    assert.deepEqual(state.pending, [])
})

test('failed automatic delivery releases ownership for an explicit wait', async () => {
    const mailboxState = createAgentMailbox()
    const published = mailboxState.publish({
        agentId: 'sa-1',
        taskName: 'delivery-test',
        role: 'worker',
        kind: 'result',
        runId: 'run-1',
        text: 'pending',
    })
    const manager = {
        claimMailbox: (options?: Parameters<typeof mailboxState.claim>[0]) =>
            mailboxState.claim(options),
        releaseMailbox: (sequences: Iterable<number>) =>
            mailboxState.release(sequences),
        ackMailbox: (sequences: Iterable<number>) =>
            mailboxState.ack(sequences),
    }
    const waiting = mailboxState.wait({ timeoutMs: 100 })
    const delivery = deliverMailbox(
        manager,
        async () => {
            throw new Error('parent unavailable')
        },
        new Map()
    )

    const [deliveryResult, waitResult] = await Promise.all([
        delivery,
        Effect.runPromise(waiting),
    ])
    assert.equal(deliveryResult.retry, true)
    assert.deepEqual(waitResult.events, [published])
})

test('concurrent mailbox flushes deliver a claimed event only once', async () => {
    const state = mailbox([envelope(1, 'result', 'run-1')])
    let sends = 0
    const sender = async () => {
        sends++
    }
    const attempts = new Map<number, number>()

    const results = await Promise.all([
        deliverMailbox(state.manager, sender, attempts),
        deliverMailbox(state.manager, sender, attempts),
    ])
    assert.equal(sends, 1)
    assert.deepEqual(state.acknowledgements, [[1]])
    assert.deepEqual(results, [
        { delivered: true, retry: false },
        { delivered: true, retry: false },
    ])
})

test('delivery keeps retrying with bounded backoff after fast failures', async () => {
    const state = mailbox([envelope(1, 'result', 'run-1')])
    const attempts = new Map<number, number>()
    const sender = async () => {
        throw new Error('parent unavailable')
    }
    const delays: number[] = []

    for (let index = 0; index < 5; index++) {
        const result = await deliverMailbox(state.manager, sender, attempts)
        delays.push(result.retryAfterMs ?? 0)
        assert.equal(result.retry, true)
        assert.equal(state.pending.length, 1)
    }
    assert.deepEqual(delays, [250, 1_000, 3_000, 10_000, 30_000])
    assert.deepEqual(attempts, new Map([[1, 5]]))
    const final = await deliverMailbox(state.manager, async () => {}, attempts)
    assert.deepEqual(final, { delivered: true, retry: false })
    assert.deepEqual(attempts, new Map())
})
