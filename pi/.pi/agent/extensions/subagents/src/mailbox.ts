import { Effect, Result } from 'effect'

export type AgentMessageKind = 'question' | 'result' | 'error' | 'cancelled'

export interface AgentEnvelope {
    readonly sequence: number
    readonly agentId: string
    readonly taskName: string
    readonly role: string
    readonly kind: AgentMessageKind
    readonly text: string
    readonly createdAt: number
}

export interface AgentMessage {
    readonly agentId: string
    readonly taskName: string
    readonly role: string
    readonly kind: AgentMessageKind
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
 * A single-consumer mailbox for parent-visible subagent messages. Delivery
 * removes an envelope, so automatic draining and explicit waits cannot emit
 * the same message twice.
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
    const waiters = new Set<() => void>()
    let nextSequence = 1
    let textBytes = 0
    let closed = false

    const notify = () => {
        for (const waiter of [...waiters]) waiter()
    }

    const forgetKey = (key: string | undefined) => {
        if (!key) return
        retainedKeys.delete(key)
        const index = retainedKeyOrder.indexOf(key)
        if (index >= 0) retainedKeyOrder.splice(index, 1)
    }

    const removeAt = (index: number) => {
        const [removed] = pending.splice(index, 1)
        if (!removed) return
        textBytes -= removed.textBytes
        // A consumed key stays in the bounded window. It still rejects retries.
    }

    const evictOldest = () => {
        const removed = pending.shift()
        if (!removed) return
        textBytes -= removed.textBytes
    }

    const trim = () => {
        while (pending.length > maxEvents || textBytes > maxTextBytes) {
            evictOldest()
        }
        while (retainedKeyOrder.length > maxEvents) {
            forgetKey(retainedKeyOrder[0])
        }
    }

    const takeAfter = (afterSequence: number) => {
        const delivered: AgentEnvelope[] = []
        for (let index = 0; index < pending.length;) {
            const stored = pending[index]
            if (stored.envelope.sequence > afterSequence) {
                delivered.push(stored.envelope)
                removeAt(index)
            } else {
                index++
            }
        }
        return delivered
    }

    const hasAfter = (afterSequence: number) =>
        pending.some((stored) => stored.envelope.sequence > afterSequence)

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
                text,
                createdAt: message.createdAt ?? Date.now(),
            }
            pending.push({
                envelope,
                textBytes: Buffer.byteLength(text, 'utf8'),
            })
            textBytes += Buffer.byteLength(text, 'utf8')
            if (message.deduplicationKey) {
                retainedKeys.add(message.deduplicationKey)
                retainedKeyOrder.push(message.deduplicationKey)
            }
            trim()
            notify()
            return envelope
        },
        drain(options: MailboxDrainOptions = {}) {
            const afterSequence = options.afterSequence ?? 0
            if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
                throw new RangeError(
                    'afterSequence must be a non-negative safe integer.'
                )
            }
            const agentIds = options.agentIds
                ? new Set(options.agentIds)
                : undefined
            const sequences = options.sequences
                ? new Set(options.sequences)
                : undefined
            const events: AgentEnvelope[] = []
            for (let index = 0; index < pending.length;) {
                const envelope = pending[index].envelope
                if (
                    envelope.sequence > afterSequence &&
                    (!agentIds || agentIds.has(envelope.agentId)) &&
                    (!sequences || sequences.has(envelope.sequence))
                ) {
                    events.push(envelope)
                    removeAt(index)
                } else {
                    index++
                }
            }
            return events
        },
        consume(sequences) {
            const selected = new Set(sequences)
            for (let index = pending.length - 1; index >= 0; index--) {
                if (selected.has(pending[index].envelope.sequence))
                    removeAt(index)
            }
        },
        wait,
        close() {
            closed = true
            notify()
        },
        get size() {
            return pending.length
        },
        get retainedTextBytes() {
            return textBytes
        },
    }
}
