import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverMailbox } from './src/delivery.ts'
import type { AgentEnvelope } from './src/mailbox.ts'

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
    const acknowledgements: number[][] = []
    return {
        pending,
        acknowledgements,
        manager: {
            peekMailbox: () => pending,
            ackMailbox: (sequences: Iterable<number>) => {
                const acknowledged = [...sequences]
                acknowledgements.push(acknowledged)
                for (const sequence of acknowledged) {
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
    assert.deepEqual(failed, { delivered: false, retry: true })
    assert.equal(state.pending.length, 1)
    assert.equal(state.acknowledgements.length, 0)

    shouldFail = false
    const delivered = await deliverMailbox(state.manager, sender, attempts)
    assert.deepEqual(delivered, { delivered: true, retry: false })
    assert.equal(state.pending.length, 0)
})
