import type { AgentEnvelope } from './mailbox.ts'
import type { SubagentManagerShape } from './manager.ts'
import { buildMailboxMessage } from './prompt.ts'

export interface ParentDeliveryMessage {
    readonly customType: 'subagent-result'
    readonly content: string
    readonly display: true
    readonly details: { readonly events: ReadonlyArray<AgentEnvelope> }
}

export interface ParentDeliveryOptions {
    readonly deliverAs: 'steer' | 'followUp'
    readonly triggerTurn: true
}

export type ParentDeliverySender = (
    message: ParentDeliveryMessage,
    options: ParentDeliveryOptions
) => void | Promise<void>

export interface DeliveryResult {
    readonly delivered: boolean
    readonly retry: boolean
}

const MAX_DELIVERY_RETRIES = 3

function recordFailure(
    events: ReadonlyArray<AgentEnvelope>,
    attempts: Map<number, number>
) {
    let retry = false
    for (const event of events) {
        const nextAttempt = (attempts.get(event.sequence) ?? 0) + 1
        if (nextAttempt <= MAX_DELIVERY_RETRIES) {
            attempts.set(event.sequence, nextAttempt)
            retry = true
        } else {
            // Keep the event pending, but wait for a later delivery opportunity.
            attempts.delete(event.sequence)
        }
    }
    return retry
}

/** Deliver pending envelopes without consuming them before the host accepts them. */
export async function deliverMailbox(
    manager: Pick<SubagentManagerShape, 'peekMailbox' | 'ackMailbox'>,
    sendMessage: ParentDeliverySender,
    attempts: Map<number, number>,
    sequences?: ReadonlyArray<number>
): Promise<DeliveryResult> {
    const events = manager.peekMailbox({ sequences })
    if (events.length === 0) return { delivered: true, retry: false }

    // Questions need steering, while ordinary results must remain follow-ups.
    // Partition contiguous groups so one mixed flush cannot steer a result.
    const batches: AgentEnvelope[][] = []
    for (const event of events) {
        const previous = batches.at(-1)
        const sameMode =
            previous &&
            (previous[0]?.kind === 'question') === (event.kind === 'question')
        if (sameMode) previous.push(event)
        else batches.push([event])
    }

    let delivered = true
    let retry = false
    for (const batch of batches) {
        try {
            await sendMessage(
                {
                    customType: 'subagent-result',
                    content: buildMailboxMessage(batch),
                    display: true,
                    details: { events: batch },
                },
                {
                    deliverAs:
                        batch[0]?.kind === 'question' ? 'steer' : 'followUp',
                    triggerTurn: true,
                }
            )
            manager.ackMailbox(batch.map((event) => event.sequence))
            for (const event of batch) attempts.delete(event.sequence)
        } catch {
            delivered = false
            retry = recordFailure(batch, attempts) || retry
        }
    }
    return { delivered, retry }
}
