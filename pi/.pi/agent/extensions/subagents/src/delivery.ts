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
    /** A retry is scheduled while failed events remain in the mailbox. */
    readonly retry: boolean
    /** Delay before the next retry, when retry is true. */
    readonly retryAfterMs?: number
    /** Events that exceeded the fast retry budget but remain retryable. */
    readonly stalledSequences?: ReadonlyArray<number>
}

/** One timer is enough; the delay grows and then remains capped. */
export const DELIVERY_RETRY_DELAYS_MS = [
    250, 1_000, 3_000, 10_000, 30_000,
] as const
const FAST_RETRY_COUNT = 3

function recordFailure(
    events: ReadonlyArray<AgentEnvelope>,
    attempts: Map<number, number>
) {
    let retryAfterMs = 0
    const stalledSequences: number[] = []
    for (const event of events) {
        const nextAttempt = (attempts.get(event.sequence) ?? 0) + 1
        attempts.set(event.sequence, nextAttempt)
        const delay =
            DELIVERY_RETRY_DELAYS_MS[
                Math.min(nextAttempt - 1, DELIVERY_RETRY_DELAYS_MS.length - 1)
            ]
        retryAfterMs = Math.max(retryAfterMs, delay)
        if (nextAttempt > FAST_RETRY_COUNT)
            stalledSequences.push(event.sequence)
    }
    return { retryAfterMs, stalledSequences }
}

/**
 * Claim pending envelopes before awaiting the host. A wait or another flush can
 * only see unclaimed events; failed sends release the exact claims for retry.
 */
export async function deliverMailbox(
    manager: Pick<
        SubagentManagerShape,
        'claimMailbox' | 'releaseMailbox' | 'ackMailbox'
    >,
    sendMessage: ParentDeliverySender,
    attempts: Map<number, number>,
    sequences?: ReadonlyArray<number>
): Promise<DeliveryResult> {
    const events = manager.claimMailbox({ sequences })
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

    const claimed = new Set(events.map((event) => event.sequence))
    let delivered = true
    let retry = false
    let retryAfterMs = 0
    const stalledSequences: number[] = []
    try {
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
                            batch[0]?.kind === 'question'
                                ? 'steer'
                                : 'followUp',
                        triggerTurn: true,
                    }
                )
                manager.ackMailbox(batch.map((event) => event.sequence))
                for (const event of batch) {
                    claimed.delete(event.sequence)
                    attempts.delete(event.sequence)
                }
            } catch {
                delivered = false
                const failure = recordFailure(batch, attempts)
                retry = true
                retryAfterMs = Math.max(retryAfterMs, failure.retryAfterMs)
                stalledSequences.push(...failure.stalledSequences)
                // Keep mailbox order strict: later batches remain claimed until
                // finally releases them and are retried after this failed batch.
                break
            }
        }
    } finally {
        // This also covers an unexpected formatter/ack failure and ensures no
        // event is left permanently in-flight after this delivery attempt.
        if (claimed.size > 0) manager.releaseMailbox(claimed)
    }

    return {
        delivered,
        retry,
        ...(retry ? { retryAfterMs } : {}),
        ...(stalledSequences.length > 0 ? { stalledSequences } : {}),
    }
}
