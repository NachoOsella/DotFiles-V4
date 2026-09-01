import { Effect, Result } from 'effect'

export type AgentMessageKind =
    'question' | 'result' | 'error' | 'cancelled' | 'gap'

export interface AgentEnvelope {
    readonly sequence: number
    readonly agentId: string
    readonly taskName: string
    readonly role: string
    readonly kind: AgentMessageKind
    readonly runId?: string
    readonly text: string
    readonly createdAt: number
    readonly droppedEvents?: number
}

export interface AgentMessage {
    readonly agentId: string
    readonly taskName: string
    readonly role: string
    readonly kind: Exclude<AgentMessageKind, 'gap'>
    readonly runId?: string
    readonly text: string
    readonly createdAt?: number
    /**
     * A stable identifier for one logical message. Repeated keys are ignored
     * while retained by the bounded deduplication window.
     */
    readonly deduplicationKey?: string
}

export interface MailboxLimits {
    readonly maxEvents?: number
    readonly maxTextBytes?: number
}

export interface MailboxDrainOptions {
    /** Only deliver events belonging to these subagents. */
    readonly agentIds?: Iterable<string>
    /** Only deliver these exact mailbox sequences. */
    readonly sequences?: Iterable<number>
    /** Only deliver messages from these runs; gap notices still match. */
    readonly runIds?: Iterable<string>
    /** Only deliver messages with a larger sequence number. */
    readonly afterSequence?: number
}

export interface MailboxWaitOptions {
    /** Only return messages with a larger sequence number. */
    readonly afterSequence?: number
    /** Resolve with `timedOut: true` when no matching message arrives in time. */
    readonly timeoutMs?: number
}

export interface MailboxWaitResult {
    readonly events: ReadonlyArray<AgentEnvelope>
    /** The last delivered sequence, or the supplied cursor when none arrived. */
    readonly nextSequence: number
    readonly timedOut: boolean
}

export interface AgentMailbox {
    /**
     * Queue a message for one delivery. Returns undefined for a duplicate key.
     */
    publish(message: AgentMessage): AgentEnvelope | undefined
    /** Inspect queued messages without consuming them. */
    peek(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Mark selected messages as delivered and remove them from the queue. */
    ack(sequences: Iterable<number>): void
    /** Deliver and consume queued messages in sequence order. */
    drain(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Remove selected messages without delivering them. */
    consume(sequences: Iterable<number>): void
    /**
     * Wait for matching messages, then deliver and consume them. Interrupting
     * the returned Effect removes its waiter without consuming any messages.
     */
    wait(options?: MailboxWaitOptions): Effect.Effect<MailboxWaitResult>
    /** Resolve pending waits. Existing queued messages remain available to drain. */
    close(): void
    readonly size: number
    readonly retainedTextBytes: number
}

const DEFAULT_MAX_EVENTS = 128
const DEFAULT_MAX_TEXT_BYTES = 128 * 1024

interface StoredEnvelope {
    readonly envelope: AgentEnvelope
    readonly textBytes: number
}

type DeliveryState = 'pending' | 'delivered' | 'consumed'

function positiveInteger(
    value: number | undefined,
    fallback: number,
    name: string
) {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new RangeError(`${name} must be a positive safe integer.`)
    }
    return resolved
}

function timeoutMs(value: number | undefined) {
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('timeoutMs must be a non-negative safe integer.')
    }
    return value
}

function truncateUtf8(text: string, maxBytes: number) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text

    let bytes = 0
    let truncated = ''
    // for...of iterates code points, so truncation cannot split a surrogate pair.
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, 'utf8')
        if (bytes + characterBytes > maxBytes) break
        truncated += character
        bytes += characterBytes
    }
    return truncated
}

/**
 * A bounded, single-consumer mailbox. Automatic delivery uses peek/ack so a
 * synchronous parent-delivery failure leaves the event queued for retry.
 */
export function createAgentMailbox(limits: MailboxLimits = {}): AgentMailbox {
    const maxEvents = positiveInteger(
        limits.maxEvents,
        DEFAULT_MAX_EVENTS,
        'maxEvents'
    )
    const maxTextBytes = positiveInteger(
        limits.maxTextBytes,
        DEFAULT_MAX_TEXT_BYTES,
        'maxTextBytes'
    )
    const pending: StoredEnvelope[] = []
    const retainedKeys = new Set<string>()
    const retainedKeyOrder: string[] = []
    const deliveryStates = new Map<number, DeliveryState>()
    const waiters = new Set<() => void>()
    let gap: StoredEnvelope | undefined
    let nextSequence = 1
    let textBytes = 0
    let closed = false

    const notify = () => {
        for (const waiter of [...waiters]) waiter()
    }

    const rememberDelivery = (sequence: number, state: DeliveryState) => {
        deliveryStates.set(sequence, state)
        while (deliveryStates.size > maxEvents * 2) {
            const oldest = deliveryStates.keys().next().value
            if (oldest === undefined) break
            deliveryStates.delete(oldest)
        }
    }

    const forgetKey = (key: string | undefined) => {
        if (!key) return
        retainedKeys.delete(key)
        const index = retainedKeyOrder.indexOf(key)
        if (index >= 0) retainedKeyOrder.splice(index, 1)
    }

    const removeStored = (stored: StoredEnvelope) => {
        if (gap?.envelope.sequence === stored.envelope.sequence) {
            gap = undefined
            return
        }
        const index = pending.indexOf(stored)
        if (index >= 0) {
            pending.splice(index, 1)
            textBytes -= stored.textBytes
        }
    }

    const removeSequence = (sequence: number, state: DeliveryState) => {
        const stored =
            gap?.envelope.sequence === sequence
                ? gap
                : pending.find(
                      (candidate) => candidate.envelope.sequence === sequence
                  )
        if (!stored) return
        rememberDelivery(sequence, state)
        removeStored(stored)
    }

    const evictOldest = () => {
        const removed = pending.shift()
        if (!removed) return undefined
        textBytes -= removed.textBytes
        rememberDelivery(removed.envelope.sequence, 'consumed')
        return removed
    }

    const addGap = (droppedEvents: number) => {
        if (droppedEvents <= 0) return
        const text = truncateUtf8(
            `Mailbox gap: ${droppedEvents} event${droppedEvents === 1 ? '' : 's'} were dropped because the mailbox limit was reached.`,
            maxTextBytes
        )
        if (gap) {
            const envelope: AgentEnvelope = {
                ...gap.envelope,
                text: truncateUtf8(
                    `Mailbox gap: at least ${
                        (gap.envelope.droppedEvents ?? 0) + droppedEvents
                    } events were dropped because the mailbox limit was reached.`,
                    maxTextBytes
                ),
                droppedEvents:
                    (gap.envelope.droppedEvents ?? 0) + droppedEvents,
            }
            gap = {
                envelope,
                textBytes: Buffer.byteLength(envelope.text, 'utf8'),
            }
            return
        }
        const envelope: AgentEnvelope = {
            sequence: nextSequence++,
            agentId: 'mailbox',
            taskName: 'mailbox-gap',
            role: 'system',
            kind: 'gap',
            text,
            createdAt: Date.now(),
            droppedEvents,
        }
        gap = {
            envelope,
            textBytes: Buffer.byteLength(text, 'utf8'),
        }
    }

    const trim = () => {
        let droppedEvents = 0
        while (pending.length > maxEvents || textBytes > maxTextBytes) {
            if (!evictOldest()) break
            droppedEvents++
        }
        addGap(droppedEvents)
        while (retainedKeyOrder.length > maxEvents) {
            forgetKey(retainedKeyOrder[0])
        }
    }

    const allStored = () =>
        [gap, ...pending]
            .filter((stored): stored is StoredEnvelope => stored !== undefined)
            .sort((a, b) => a.envelope.sequence - b.envelope.sequence)

    const matches = (
        envelope: AgentEnvelope,
        options: MailboxDrainOptions,
        afterSequence: number
    ) => {
        const agentIds = options.agentIds
            ? new Set(options.agentIds)
            : undefined
        const sequences = options.sequences
            ? new Set(options.sequences)
            : undefined
        const runIds = options.runIds ? new Set(options.runIds) : undefined
        return (
            envelope.sequence > afterSequence &&
            (!agentIds ||
                envelope.kind === 'gap' ||
                agentIds.has(envelope.agentId)) &&
            (!sequences || sequences.has(envelope.sequence)) &&
            (!runIds ||
                envelope.kind === 'gap' ||
                (envelope.runId !== undefined && runIds.has(envelope.runId)))
        )
    }

    const selected = (options: MailboxDrainOptions = {}) => {
        const afterSequence = options.afterSequence ?? 0
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new RangeError(
                'afterSequence must be a non-negative safe integer.'
            )
        }
        return allStored().filter((stored) =>
            matches(stored.envelope, options, afterSequence)
        )
    }

    const takeAfter = (afterSequence: number) => {
        const delivered = selected({ afterSequence })
        for (const stored of delivered) {
            removeSequence(stored.envelope.sequence, 'consumed')
        }
        return delivered.map((stored) => stored.envelope)
    }

    const hasAfter = (afterSequence: number) =>
        allStored().some((stored) => stored.envelope.sequence > afterSequence)

    const waitForMatching = (afterSequence: number) =>
        Effect.callback<void>((resume) => {
            const wake = () => {
                if (!closed && !hasAfter(afterSequence)) return
                waiters.delete(wake)
                resume(Effect.void)
            }
            waiters.add(wake)
            wake()
            return Effect.sync(() => waiters.delete(wake))
        })

    const wait = (options: MailboxWaitOptions = {}) => {
        const afterSequence = options.afterSequence ?? 0
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new RangeError(
                'afterSequence must be a non-negative safe integer.'
            )
        }
        const limit = timeoutMs(options.timeoutMs)

        const take = (): Effect.Effect<ReadonlyArray<AgentEnvelope>> =>
            Effect.suspend(() => {
                if (closed) return Effect.succeed([])
                const events = takeAfter(afterSequence)
                if (events.length > 0) return Effect.succeed(events)
                return waitForMatching(afterSequence).pipe(
                    Effect.andThen(take())
                )
            })

        const deliver = (
            events: ReadonlyArray<AgentEnvelope>,
            timedOut: boolean
        ) => ({
            events,
            nextSequence: events.at(-1)?.sequence ?? afterSequence,
            timedOut,
        })

        if (limit === undefined)
            return take().pipe(Effect.map((events) => deliver(events, false)))

        return take().pipe(
            Effect.timeout(limit),
            Effect.result,
            Effect.map((result) =>
                Result.isSuccess(result)
                    ? deliver(result.success, false)
                    : deliver([], true)
            )
        )
    }

    return {
        publish(message) {
            if (
                message.deduplicationKey &&
                retainedKeys.has(message.deduplicationKey)
            ) {
                return undefined
            }
            const text = truncateUtf8(message.text, maxTextBytes)
            const envelope: AgentEnvelope = {
                sequence: nextSequence++,
                agentId: message.agentId,
                taskName: message.taskName,
                role: message.role,
                kind: message.kind,
                ...(message.runId ? { runId: message.runId } : {}),
                text,
                createdAt: message.createdAt ?? Date.now(),
            }
            pending.push({
                envelope,
                textBytes: Buffer.byteLength(text, 'utf8'),
            })
            textBytes += Buffer.byteLength(text, 'utf8')
            rememberDelivery(envelope.sequence, 'pending')
            if (message.deduplicationKey) {
                retainedKeys.add(message.deduplicationKey)
                retainedKeyOrder.push(message.deduplicationKey)
            }
            trim()
            notify()
            return envelope
        },
        peek(options: MailboxDrainOptions = {}) {
            return selected(options).map((stored) => stored.envelope)
        },
        ack(sequences) {
            for (const sequence of new Set(sequences)) {
                removeSequence(sequence, 'delivered')
            }
        },
        drain(options: MailboxDrainOptions = {}) {
            const events = selected(options)
            for (const stored of events) {
                removeSequence(stored.envelope.sequence, 'consumed')
            }
            return events.map((stored) => stored.envelope)
        },
        consume(sequences) {
            for (const sequence of new Set(sequences)) {
                removeSequence(sequence, 'consumed')
            }
        },
        wait,
        close() {
            closed = true
            notify()
        },
        get size() {
            return pending.length + (gap ? 1 : 0)
        },
        get retainedTextBytes() {
            return textBytes
        },
    }
}
