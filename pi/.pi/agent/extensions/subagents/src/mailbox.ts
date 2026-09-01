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
    /** Inspect pending messages without consuming or claiming them. */
    peek(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Atomically claim pending messages for one asynchronous consumer. */
    claim(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Release claims after a failed asynchronous delivery. */
    release(sequences: Iterable<number>): void
    /** Mark selected claimed messages as delivered and remove them from the queue. */
    ack(sequences: Iterable<number>): void
    /** Deliver and consume pending messages in sequence order. */
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

type DeliveryState = 'pending' | 'in-flight' | 'delivered' | 'consumed'

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
 * A bounded, single-process mailbox. Automatic delivery claims an event before
 * awaiting the parent sender; explicit drains only see unclaimed pending events.
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
    let deferredDroppedEvents = 0
    let nextSequence = 1
    let textBytes = 0
    let closed = false

    const notify = () => {
        for (const waiter of [...waiters]) waiter()
    }

    const rememberDelivery = (sequence: number, state: DeliveryState) => {
        deliveryStates.set(sequence, state)
        while (deliveryStates.size > maxEvents * 2) {
            const oldest = [...deliveryStates].find(
                ([, current]) => current !== 'in-flight'
            )?.[0]
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
        const isGap = gap?.envelope.sequence === sequence
        const stored = isGap
            ? gap
            : pending.find(
                  (candidate) => candidate.envelope.sequence === sequence
              )
        if (!stored) return
        const current = deliveryStates.get(sequence) ?? 'pending'
        if (state === 'consumed' && current !== 'pending') return
        if (
            state === 'delivered' &&
            current !== 'pending' &&
            current !== 'in-flight'
        )
            return
        rememberDelivery(sequence, state)
        removeStored(stored)
        if (isGap && state === 'delivered' && deferredDroppedEvents > 0) {
            const dropped = deferredDroppedEvents
            deferredDroppedEvents = 0
            addGap(dropped)
        }
    }

    const evictOldest = () => {
        const index = pending.findIndex(
            (stored) =>
                (deliveryStates.get(stored.envelope.sequence) ?? 'pending') ===
                'pending'
        )
        if (index < 0) return undefined
        const [removed] = pending.splice(index, 1)
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
            if (deliveryStates.get(gap.envelope.sequence) === 'in-flight') {
                deferredDroppedEvents += droppedEvents
                return
            }
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
            rememberDelivery(envelope.sequence, 'pending')
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
        rememberDelivery(envelope.sequence, 'pending')
    }

    const mergeDeferredGap = () => {
        if (
            deferredDroppedEvents <= 0 ||
            !gap ||
            deliveryStates.get(gap.envelope.sequence) !== 'in-flight'
        )
            return
        const envelope: AgentEnvelope = {
            ...gap.envelope,
            text: truncateUtf8(
                `Mailbox gap: at least ${(gap.envelope.droppedEvents ?? 0) + deferredDroppedEvents} events were dropped because the mailbox limit was reached.`,
                maxTextBytes
            ),
            droppedEvents:
                (gap.envelope.droppedEvents ?? 0) + deferredDroppedEvents,
        }
        deferredDroppedEvents = 0
        gap = {
            envelope,
            textBytes: Buffer.byteLength(envelope.text, 'utf8'),
        }
        rememberDelivery(envelope.sequence, 'in-flight')
    }

    const trim = () => {
        let droppedEvents = 0
        const pendingStats = () => {
            let count = 0
            let bytes = 0
            for (const stored of pending) {
                if (
                    (deliveryStates.get(stored.envelope.sequence) ??
                        'pending') !== 'pending'
                )
                    continue
                count++
                bytes += stored.textBytes
            }
            return { count, bytes }
        }
        while (true) {
            const stats = pendingStats()
            if (stats.count <= maxEvents && stats.bytes <= maxTextBytes) break
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
        return allStored().filter(
            (stored) =>
                (deliveryStates.get(stored.envelope.sequence) ?? 'pending') ===
                    'pending' &&
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
        allStored().some(
            (stored) =>
                (deliveryStates.get(stored.envelope.sequence) ?? 'pending') ===
                    'pending' && stored.envelope.sequence > afterSequence
        )

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
        claim(options: MailboxDrainOptions = {}) {
            const events = selected(options)
            for (const stored of events)
                rememberDelivery(stored.envelope.sequence, 'in-flight')
            return events.map((stored) => stored.envelope)
        },
        release(sequences) {
            let released = false
            for (const sequence of new Set(sequences)) {
                if (deliveryStates.get(sequence) !== 'in-flight') continue
                mergeDeferredGap()
                rememberDelivery(sequence, 'pending')
                released = true
            }
            if (released) notify()
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
