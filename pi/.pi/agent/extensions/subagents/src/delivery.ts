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
/**
 * Aggregate parent-delivery budget. A per-envelope cap is not enough when
 * many events are combined, so mode batches are further split into chunks
 * whose rendered message stays within this 32 KiB-class limit.
 */
export const MAX_DELIVERY_CONTENT_BYTES = 32 * 1024
const DELIVERY_TRUNCATION_MARKER =
    '\n\n[Output truncated to the parent delivery budget; use subagent_check for the full result.]'

function truncateUtf8(text: string, maxBytes: number) {
    if (maxBytes <= 0) return ''
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
    const markerBytes = Buffer.byteLength(DELIVERY_TRUNCATION_MARKER, 'utf8')
    const bodyBudget = Math.max(0, maxBytes - markerBytes)
    let body = ''
    let bytes = 0
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, 'utf8')
        if (bytes + characterBytes > bodyBudget) break
        body += character
        bytes += characterBytes
    }
    if (markerBytes <= maxBytes)
        return `${body}${DELIVERY_TRUNCATION_MARKER}`
    let fallback = ''
    let fallbackBytes = 0
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, 'utf8')
        if (fallbackBytes + characterBytes > maxBytes) break
        fallback += character
        fallbackBytes += characterBytes
    }
    return fallback
}

function boundedDeliveryContent(batch: ReadonlyArray<AgentEnvelope>) {
    return truncateUtf8(
        buildMailboxMessage(batch),
        MAX_DELIVERY_CONTENT_BYTES
    )
}

function splitByContentBudget(
    batch: ReadonlyArray<AgentEnvelope>
): AgentEnvelope[][] {
    const chunks: AgentEnvelope[][] = []
    let current: AgentEnvelope[] = []
    for (const event of batch) {
        const candidate = [...current, event]
        if (
            current.length > 0 &&
            Buffer.byteLength(buildMailboxMessage(candidate), 'utf8') >
                MAX_DELIVERY_CONTENT_BYTES
        ) {
            chunks.push(current)
            current = [event]
            continue
        }
        current = candidate
    }
    if (current.length > 0) chunks.push(current)
    return chunks
}

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
    // Each mode group is further split so no single parent message exceeds
    // the aggregate content budget when many events are combined.
    const modeBatches: AgentEnvelope[][] = []
    for (const event of events) {
        const previous = modeBatches.at(-1)
        const sameMode =
            previous &&
            (previous[0]?.kind === 'question') === (event.kind === 'question')
        if (sameMode) previous.push(event)
        else modeBatches.push([event])
    }
    const batches: AgentEnvelope[][] = modeBatches.flatMap(splitByContentBudget)

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
                        content: boundedDeliveryContent(batch),
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
