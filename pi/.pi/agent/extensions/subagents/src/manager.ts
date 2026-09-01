/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import * as path from 'node:path'
import {
    Context,
    Effect,
    Exit,
    Fiber,
    Layer,
    Result,
    Scope,
    Stream,
} from 'effect'
import type {
    BackendCloseResult,
    SendDelivery,
    SubagentBackend,
    SubagentSession,
} from './backend.ts'
import { BackendRegistry } from './backend.ts'
import {
    createAgentMailbox,
    type AgentEnvelope,
    type AgentMailbox,
    type MailboxWaitOptions,
    type MailboxWaitResult,
} from './mailbox.ts'
import {
    isAgentRoleName,
    resolveAgentExecutionOptions,
    resolveAgentRole,
} from './roles.ts'
import {
    DEFAULT_MAX_RUNNING,
    DEFAULT_MAX_TRACKED,
    loadSubagentConfig,
    type SubagentConfig,
} from './config.ts'
import type {
    BackendName,
    LiveToolState,
    RunOutcome,
    SpawnTask,
    SubagentEvent,
    SubagentMeta,
    SubagentSnapshot,
    SubagentStatus,
    TranscriptItem,
    TranscriptPart,
} from './domain.ts'
import {
    BackendUnavailableError,
    ConcurrencyLimitError,
    SendError,
    SpawnError,
} from './domain.ts'

export const MAX_RUNNING = DEFAULT_MAX_RUNNING
export const MAX_TRACKED = DEFAULT_MAX_TRACKED
const STOP_TIMEOUT_MS = 5_000
const ERROR_TEXT_MAX_LENGTH = 4_096
export const MAX_SPAWN_PROMPT_BYTES = 24 * 1024
export const MAX_TRANSCRIPT_BYTES = 256 * 1024
export const MAX_TRANSCRIPT_ITEM_BYTES = 64 * 1024
export const MAX_LIVE_ASSISTANT_BYTES = 256 * 1024
export const MAX_FINAL_TEXT_BYTES = 8 * 1024
export const MAX_MAILBOX_RESULT_BYTES = 8 * 1024
export const MAX_SEND_MESSAGE_BYTES = 8 * 1024
const TRUNCATION_MARKER = '\n[truncated]'

function textBytes(text: string) {
    return Buffer.byteLength(text, 'utf8')
}

/** Truncate a UTF-8 string without splitting a code point. */
function truncateUtf8(text: string, maxBytes: number, keepTail = false) {
    if (maxBytes <= 0) return ''
    if (textBytes(text) <= maxBytes) return text
    const marker =
        textBytes(TRUNCATION_MARKER) <= maxBytes ? TRUNCATION_MARKER : ''
    const markerBytes = textBytes(marker)
    const available = maxBytes - markerBytes
    const characters = [...text]
    let bytes = 0
    const retained: string[] = []
    const source = keepTail ? characters.reverse() : characters
    for (const character of source) {
        const size = textBytes(character)
        if (bytes + size > available) break
        retained.push(character)
        bytes += size
    }
    const body = keepTail ? retained.reverse().join('') : retained.join('')
    return keepTail ? marker + body : body + marker
}

function bounded(text: string) {
    return truncateUtf8(text, ERROR_TEXT_MAX_LENGTH)
}

function boundedMailboxText(text: string, sessionPath?: string) {
    const suffix = sessionPath ? `\n\n[Full transcript: ${sessionPath}]` : ''
    if (textBytes(text) + textBytes(suffix) <= MAX_MAILBOX_RESULT_BYTES) {
        return text
    }
    if (textBytes(suffix) >= MAX_MAILBOX_RESULT_BYTES) {
        return truncateUtf8(suffix, MAX_MAILBOX_RESULT_BYTES)
    }
    return `${truncateUtf8(
        text,
        MAX_MAILBOX_RESULT_BYTES - textBytes(suffix)
    )}${suffix}`
}

function normalizedTaskName(value: string) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 160)
    return normalized || 'subagent'
}

function normalizeOwnedPath(cwd: string, value: string) {
    return path.resolve(cwd, value.trim())
}

function ownershipRoot(value: string) {
    const normalized = value.replaceAll('\\\\', '/')
    const wildcard = normalized.search(/[\\*?]/)
    const root = wildcard >= 0 ? normalized.slice(0, wildcard) : normalized
    return root.replace(/\/+$/, '') || path.parse(normalized).root
}

function pathsOverlap(left: string, right: string) {
    const leftRoot = ownershipRoot(left)
    const rightRoot = ownershipRoot(right)
    const contains = (candidate: string, parent: string) =>
        candidate === parent ||
        (parent === '/'
            ? candidate.startsWith('/')
            : candidate.startsWith(`${parent}/`))
    return contains(leftRoot, rightRoot) || contains(rightRoot, leftRoot)
}

function findOwnershipOverlap(
    current: ReadonlyArray<string>,
    existing: ReadonlyArray<string>
) {
    return current.some((left) =>
        existing.some((right) => pathsOverlap(left, right))
    )
}

function boundedTranscriptItem(item: TranscriptItem): TranscriptItem {
    switch (item.kind) {
        case 'user':
            return {
                ...item,
                text: truncateUtf8(item.text, MAX_TRANSCRIPT_ITEM_BYTES, true),
            }
        case 'toolResult':
            return {
                ...item,
                toolId: truncateUtf8(item.toolId, 1_024),
                name: truncateUtf8(item.name, 1_024),
                outputPreview: item.outputPreview
                    ? truncateUtf8(
                          item.outputPreview,
                          MAX_TRANSCRIPT_ITEM_BYTES - 2_048,
                          true
                      )
                    : undefined,
            }
        case 'assistant': {
            const parts: { kind: 'assistant'; parts: TranscriptPart[] } = {
                kind: 'assistant',
                parts: item.parts.map((part) => {
                    switch (part.type) {
                        case 'text':
                            return {
                                ...part,
                                text: truncateUtf8(part.text, 16 * 1024, true),
                            }
                        case 'thinking':
                            return {
                                ...part,
                                text: truncateUtf8(part.text, 16 * 1024, true),
                            }
                        case 'toolCall':
                            return {
                                ...part,
                                argsPreview: part.argsPreview
                                    ? truncateUtf8(
                                          part.argsPreview,
                                          16 * 1024,
                                          true
                                      )
                                    : undefined,
                            }
                    }
                }),
            }
            while (
                textBytes(JSON.stringify(parts)) > MAX_TRANSCRIPT_ITEM_BYTES
            ) {
                if (parts.parts.length <= 1) {
                    return {
                        kind: 'assistant',
                        parts: [{ type: 'text', text: TRUNCATION_MARKER }],
                    }
                }
                parts.parts = parts.parts.slice(1)
            }
            return parts
        }
    }
}

function transcriptItemBytes(item: TranscriptItem) {
    return textBytes(JSON.stringify(item))
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
    id: string
    backend: BackendName
    title: string
    taskName: string
    role: string
    version: number
    transcriptVersion: number
    lastMailboxSequence?: number
    prompt: string
    cwd: string
    status: SubagentStatus
    currentRunId?: string
    lastRun?: SubagentSnapshot['lastRun']
    ownedPaths: ReadonlyArray<string>
    ownershipWarning?: string
    createdAt: number
    settledAt?: number
    errorText?: string
    meta: SubagentMeta
    usage: { tokens?: number; contextWindow?: number }
    transcript: TranscriptItem[]
    liveAssistant?: { text: string; thinking: string }
    liveTools: LiveToolState[]
    queued: SubagentSnapshot['queued']
    finalText: string
    turns: number
}

interface Entry {
    snapshot: MutableSnapshot
    session: SubagentSession
    scope: Scope.Closeable
    pump?: Fiber.Fiber<void>
    liveToolMap: Map<string, LiveToolState>
    /** Idle restart dispatched but RunStarted not folded yet. */
    restarting?: boolean
    /** Terminal state to restore if the backend rejects an idle restart. */
    restartState?: Pick<
        MutableSnapshot,
        'status' | 'settledAt' | 'errorText' | 'lastRun'
    >
    nextRunNumber: number
    pendingRunIds: Set<string>
    runStartedAt: number
    /** Monotonic manager action used to avoid time-based wait metrics. */
    spawnActionSequence: number
    lastActionSequence: number
    lastSettlementSequence?: number
    /** A bounded teardown failed; keep close reports conservative thereafter. */
    closeIncomplete?: boolean
    closeStatus?: BackendCloseResult
    /** Close has been requested; reject sends before cleanup finishes. */
    closing?: boolean
    closed: boolean
    immediateWaitRecorded?: boolean
    transcriptBytes: number
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
    list(): ReadonlyArray<SubagentSnapshot>
    get(id: string): SubagentSnapshot | undefined
    size(): number
    /** Any-change notification (footer status, dashboard). */
    subscribe(listener: () => void): () => void
    /** Per-subagent notification (takeover view). */
    subscribeTo(id: string, listener: () => void): () => void
    /** Fire-and-forget: steer/continue a subagent (takeover input). */
    requestSend(id: string, text: string): void
    /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
    requestAbort(id: string): void
    /** Fire-and-forget: close a subagent and release its resources. */
    requestClose(id: string): void
    /**
     * Register the settle hook. `consumed` is true when an active
     * subagent_wait/cancel is collecting the result (so it must not also be
     * delivered as a follow-up message).
     */
    setOnSettled(
        hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined
    ): void
}

// --- Service --------------------------------------------------------------------

export interface WaitResult {
    readonly completed: ReadonlyArray<string>
    readonly pending: ReadonlyArray<string>
    readonly timedOut: boolean
    /** Settlement and gap messages consumed by this wait. */
    readonly events: ReadonlyArray<AgentEnvelope>
}

export interface CancelResult {
    readonly id: string
    readonly title: string
    readonly status: SubagentStatus
    readonly cancelled: boolean
}

export interface CloseResult {
    readonly id: string
    readonly title: string
    readonly status: SubagentStatus
    /** The session is terminal and cannot be reused. */
    readonly terminal: boolean
    /** Whether backend and scope cleanup were confirmed successful. */
    readonly resourcesReleased: boolean
    /** Legacy alias for resourcesReleased. */
    readonly closed: boolean
    readonly error?: string
}

export interface DelegationMetrics {
    readonly agentsSpawned: number
    readonly immediateWaits: number
    readonly roles: Readonly<Record<string, number>>
}

export interface MailboxDrainOptions {
    readonly agentIds?: ReadonlyArray<string>
    readonly afterSequence?: number
    readonly sequences?: ReadonlyArray<number>
    readonly runIds?: ReadonlyArray<string>
}

export interface SubagentManagerShape {
    spawn(
        backend: BackendName,
        task: SpawnTask
    ): Effect.Effect<
        SubagentSnapshot,
        SpawnError | ConcurrencyLimitError | BackendUnavailableError
    >
    /**
     * Wait until all listed subagents are settled. Unknown ids are treated as
     * settled (the tool layer validates ids first). While waiting, settles for
     * these ids are marked "consumed". Interruption (tool abort) releases the
     * interest and leaves the subagents running.
     */
    waitFor(
        ids: ReadonlyArray<string>,
        onPending?: (pending: string[]) => void,
        timeoutMs?: number
    ): Effect.Effect<WaitResult>
    /** Interrupt running subagents; they remain reusable. */
    interrupt(
        ids: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<CancelResult>>
    /** Compatibility alias for interrupt. */
    cancel(
        ids: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<CancelResult>>
    /** Close subagents permanently and release their backend scopes. */
    close(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CloseResult>>
    send(
        id: string,
        text: string,
        delivery?: SendDelivery
    ): Effect.Effect<void, SendError>
    /** Wait for mailbox activity without requiring a subagent id. */
    waitForMailbox(
        options?: MailboxWaitOptions
    ): Effect.Effect<MailboxWaitResult>
    /** Inspect mailbox events without consuming them. */
    peekMailbox(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Claim mailbox events for one asynchronous parent delivery attempt. */
    claimMailbox(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Release failed parent-delivery claims for retry. */
    releaseMailbox(sequences: Iterable<number>): void
    /** Acknowledge successful parent delivery. */
    ackMailbox(sequences: Iterable<number>): void
    /** Consume mailbox events, optionally only for selected subagents. */
    drainMailbox(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Subscribe to newly published mailbox messages for parent delivery. */
    setOnMailbox(hook: ((envelope: AgentEnvelope) => void) | undefined): void
    /** The manager-owned mailbox. Prefer waitForMailbox/drainMailbox in tools. */
    readonly mailbox: AgentMailbox
    get(id: string): Effect.Effect<SubagentSnapshot | undefined>
    readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>
    readonly disposeAll: Effect.Effect<void>
    readonly getMetrics: () => DelegationMetrics
    readonly view: SubagentReadModel
}

export class SubagentManager extends Context.Service<
    SubagentManager,
    SubagentManagerShape
>()('subagents/SubagentManager') {}

// --- Implementation --------------------------------------------------------------

const makeManager = (config: SubagentConfig) =>
    Effect.gen(function* () {
        const registry = yield* BackendRegistry
        // Detached forker for sync contexts (read-model commands, pruning) that
        // preserves the manager's services instead of using the global runtime.
        const runDetached = Effect.runForkWith(yield* Effect.context())

        const entries = new Map<string, Entry>()
        const mailbox = createAgentMailbox()
        const reservedTaskNames = new Set<string>()
        const waitInterest = new Map<string, number>()
        const suppressedDeliveries = new Map<number, AgentEnvelope>()
        const listeners = new Set<() => void>()
        /** One-shot nextChange waiters, swapped out before invocation so waiters
         * re-registering during notification are not visited in the same sweep. */
        let changeWaiters: Array<() => void> = []
        const idListeners = new Map<string, Set<() => void>>()
        const cleanups = new Set<Fiber.Fiber<unknown>>()
        let counter = 0
        let reserved = 0
        let actionSequence = 0
        let disposed = false
        const metrics = {
            agentsSpawned: 0,
            immediateWaits: 0,
            roles: {} as Record<string, number>,
        }
        let onSettled:
            ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined
        let onMailbox: ((envelope: AgentEnvelope) => void) | undefined

        const bump = (snapshot: MutableSnapshot) => {
            snapshot.version++
            snapshot.transcriptVersion++
        }

        const appendTranscript = (entry: Entry, item: TranscriptItem) => {
            const boundedItem = boundedTranscriptItem(item)
            entry.snapshot.transcript.push(boundedItem)
            entry.transcriptBytes += transcriptItemBytes(boundedItem)
            entry.snapshot.transcriptVersion++
            while (
                entry.snapshot.transcript.length > 0 &&
                entry.transcriptBytes > MAX_TRANSCRIPT_BYTES
            ) {
                const removed = entry.snapshot.transcript.shift()
                if (removed)
                    entry.transcriptBytes -= transcriptItemBytes(removed)
            }
        }

        const notify = (id?: string) => {
            const waiters = changeWaiters
            changeWaiters = []
            for (const waiter of waiters) waiter()
            for (const listener of [...listeners]) {
                try {
                    listener()
                } catch {
                    // A failed status/render listener must not corrupt lifecycle state.
                }
            }
            if (id) {
                for (const listener of idListeners.get(id) ?? []) {
                    try {
                        listener()
                    } catch {
                        // Same.
                    }
                }
            }
        }

        /** Resolves on the next state change. Interruption unregisters the waiter. */
        const nextChange = Effect.callback<void>((resume) => {
            const waiter = () => resume(Effect.void)
            changeWaiters.push(waiter)
            return Effect.sync(() => {
                const index = changeWaiters.indexOf(waiter)
                if (index >= 0) changeWaiters.splice(index, 1)
            })
        })

        const pendingWork = (entry: Entry) =>
            entry.snapshot.status === 'running' ||
            entry.restarting === true ||
            entry.pendingRunIds.size > 0

        const runningCount = () =>
            [...entries.values()].filter(pendingWork).length

        const addInterest = (ids: ReadonlyArray<string>) => {
            for (const id of ids)
                waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1)
        }
        const releaseInterest = (ids: ReadonlyArray<string>) => {
            for (const id of ids) {
                const count = (waitInterest.get(id) ?? 1) - 1
                if (count > 0) {
                    waitInterest.set(id, count)
                    continue
                }
                waitInterest.delete(id)
                if (disposed || !onMailbox) continue
                for (const [sequence, envelope] of suppressedDeliveries) {
                    if (envelope.agentId !== id) continue
                    const pending = mailbox.peek({ sequences: [sequence] })
                    const gap =
                        pending.length > 0
                            ? pending[0]
                            : mailbox
                                  .peek()
                                  .find((event) => event.kind === 'gap')
                    if (!gap) {
                        suppressedDeliveries.delete(sequence)
                        continue
                    }
                    suppressedDeliveries.delete(sequence)
                    try {
                        onMailbox(gap)
                    } catch {
                        // Parent delivery failures must not fail the wait cleanup.
                    }
                }
            }
        }

        const closeScope = (scope: Scope.Closeable) =>
            Scope.close(scope, Exit.void).pipe(Effect.ignore)
        const closeEntryScope = (entry: Entry) => closeScope(entry.scope)

        const pruneSettled = () => {
            if (entries.size <= config.maxTracked) return
            const candidates = [...entries.values()]
                .filter(
                    (e) => !pendingWork(e) && !waitInterest.has(e.snapshot.id)
                )
                .sort(
                    (a, b) =>
                        (a.snapshot.settledAt ?? a.snapshot.createdAt) -
                        (b.snapshot.settledAt ?? b.snapshot.createdAt)
                )
            for (const entry of candidates) {
                if (entries.size <= config.maxTracked) break
                entries.delete(entry.snapshot.id)
                const fiber = runDetached(closeEntryScope(entry))
                cleanups.add(fiber)
                fiber.addObserver(() => cleanups.delete(fiber))
            }
        }

        const publishMailbox = (
            message: Parameters<AgentMailbox['publish']>[0],
            notifyDelivery = true
        ) => {
            const envelope = mailbox.publish(message)
            if (!envelope) return undefined
            const entry = entries.get(envelope.agentId)
            if (entry) {
                entry.snapshot.lastMailboxSequence = envelope.sequence
                bump(entry.snapshot)
                notify(entry.snapshot.id)
            }
            if (notifyDelivery) {
                try {
                    onMailbox?.(envelope)
                } catch {
                    // Parent delivery failures must not affect child lifecycle state.
                }
            }
            return envelope
        }

        const settle = (
            entry: Entry,
            outcome: RunOutcome,
            runId = entry.snapshot.currentRunId
        ) => {
            const s = entry.snapshot
            if (
                entry.closed ||
                s.status !== 'running' ||
                !runId ||
                s.currentRunId !== runId
            )
                return
            entry.restarting = false
            entry.restartState = undefined
            s.settledAt = Date.now()
            let output = ''
            let error: string | undefined
            let runStatus: NonNullable<SubagentSnapshot['lastRun']>['status']
            switch (outcome._tag) {
                case 'Completed':
                    s.status = 'done'
                    s.errorText = undefined
                    output = truncateUtf8(
                        outcome.finalText,
                        MAX_FINAL_TEXT_BYTES
                    )
                    s.finalText = output
                    runStatus = 'completed'
                    break
                case 'Failed':
                    s.status = 'error'
                    error = bounded(outcome.errorText)
                    s.errorText = error
                    output = truncateUtf8(
                        outcome.partialText ?? '',
                        MAX_FINAL_TEXT_BYTES
                    )
                    // A failed run must never reuse the previous run's output.
                    s.finalText = output
                    runStatus = 'failed'
                    break
                case 'Interrupted':
                    s.status = 'error'
                    error = 'Run was aborted'
                    s.errorText = error
                    output = truncateUtf8(
                        outcome.partialText ?? '',
                        MAX_FINAL_TEXT_BYTES
                    )
                    s.finalText = output
                    runStatus = 'interrupted'
                    break
            }
            s.lastRun = {
                id: runId,
                agentId: s.id,
                status: runStatus,
                startedAt: entry.runStartedAt,
                finishedAt: s.settledAt,
                output: output || undefined,
                error,
            }
            s.liveAssistant = undefined
            entry.liveToolMap.clear()
            s.liveTools = []
            s.queued = []
            const kind =
                outcome._tag === 'Completed'
                    ? 'result'
                    : outcome._tag === 'Interrupted'
                      ? 'cancelled'
                      : 'error'
            const sourceText =
                kind === 'error'
                    ? `${s.errorText ?? 'Subagent run failed'}\n${s.finalText}`.trim()
                    : s.finalText || s.errorText || '(no output)'
            const text = boundedMailboxText(sourceText, s.meta.sessionFilePath)
            const consumed = (waitInterest.get(s.id) ?? 0) > 0
            let envelope: AgentEnvelope | undefined
            if (!disposed) {
                envelope = publishMailbox(
                    {
                        agentId: s.id,
                        taskName: s.taskName,
                        role: s.role,
                        kind,
                        runId,
                        text,
                        deduplicationKey: `settlement:${s.id}:${runId}`,
                    },
                    false
                )
                entry.lastSettlementSequence = envelope?.sequence
                if (consumed && envelope)
                    suppressedDeliveries.set(envelope.sequence, envelope)
            }
            bump(s)
            notify(s.id)
            try {
                // The extension wires this hook to schedule only unconsumed results.
                if (!disposed) onSettled?.(s, consumed)
                if (!disposed && !onSettled && !consumed && envelope)
                    onMailbox?.(envelope)
            } catch {
                // The parent session may be unavailable; settlement stays final.
            }
            pruneSettled()
        }

        const failPendingRuns = (entry: Entry, errorText: string) => {
            while (entry.pendingRunIds.size > 0) {
                const runId = entry.pendingRunIds.values().next().value
                if (!runId) break
                entry.pendingRunIds.delete(runId)
                const snapshot = entry.snapshot
                snapshot.currentRunId = runId
                entry.runStartedAt = Date.now()
                snapshot.status = 'running'
                snapshot.settledAt = undefined
                snapshot.lastRun = {
                    id: runId,
                    agentId: snapshot.id,
                    status: 'running',
                    startedAt: entry.runStartedAt,
                }
                settle(entry, { _tag: 'Failed', errorText }, runId)
            }
        }

        const foldEvent = (entry: Entry, event: SubagentEvent) => {
            if (entry.closed) return
            const s = entry.snapshot
            if (
                event._tag !== 'RunStarted' &&
                event._tag !== 'RunSettled' &&
                event.runId !== undefined &&
                event.runId !== s.currentRunId
            )
                return
            switch (event._tag) {
                case 'RunStarted': {
                    // A late start from an older run must not overwrite a newer run.
                    const expectedRun = entry.pendingRunIds.delete(event.runId)
                    if (
                        !expectedRun &&
                        s.currentRunId &&
                        s.currentRunId !== event.runId
                    )
                        return
                    if (
                        !expectedRun &&
                        s.status !== 'running' &&
                        s.lastRun?.id === event.runId
                    )
                        return
                    entry.restarting = false
                    entry.restartState = undefined
                    s.currentRunId = event.runId
                    entry.runStartedAt = Date.now()
                    s.status = 'running'
                    s.settledAt = undefined
                    s.errorText = undefined
                    s.lastRun = {
                        id: event.runId,
                        agentId: s.id,
                        status: 'running',
                        startedAt: entry.runStartedAt,
                    }
                    s.finalText = ''
                    s.liveAssistant = undefined
                    entry.liveToolMap.clear()
                    s.liveTools = []
                    s.queued = []
                    break
                }
                case 'RunSettled':
                    // Terminal events are correlated to the current run. This also
                    // prevents a late event from settling an idle restart.
                    if (s.currentRunId !== event.runId) return
                    settle(entry, event.outcome, event.runId)
                    return // settle() already notified
                case 'UserMessage':
                    appendTranscript(entry, { kind: 'user', text: event.text })
                    break
                case 'AssistantDelta': {
                    const live = s.liveAssistant ?? { text: '', thinking: '' }
                    s.liveAssistant =
                        event.kind === 'text'
                            ? {
                                  ...live,
                                  text: truncateUtf8(
                                      live.text + event.delta,
                                      MAX_LIVE_ASSISTANT_BYTES / 2,
                                      true
                                  ),
                              }
                            : {
                                  ...live,
                                  thinking: truncateUtf8(
                                      live.thinking + event.delta,
                                      MAX_LIVE_ASSISTANT_BYTES / 2,
                                      true
                                  ),
                              }
                    break
                }
                case 'AssistantMessage':
                    appendTranscript(entry, {
                        kind: 'assistant',
                        parts: event.parts,
                    })
                    s.liveAssistant = undefined
                    s.turns++
                    break
                case 'ToolStart':
                    entry.liveToolMap.set(event.toolId, {
                        toolId: event.toolId,
                        name: event.name,
                        argsPreview: event.argsPreview,
                    })
                    s.liveTools = [...entry.liveToolMap.values()]
                    break
                case 'ToolUpdate': {
                    const current = entry.liveToolMap.get(event.toolId)
                    if (current) {
                        entry.liveToolMap.set(event.toolId, {
                            ...current,
                            outputPreview:
                                event.outputPreview ?? current.outputPreview,
                        })
                        s.liveTools = [...entry.liveToolMap.values()]
                    }
                    break
                }
                case 'ToolEnd':
                    entry.liveToolMap.delete(event.toolId)
                    s.liveTools = [...entry.liveToolMap.values()]
                    appendTranscript(entry, {
                        kind: 'toolResult',
                        toolId: event.toolId,
                        name: event.name,
                        isError: event.isError,
                        outputPreview: event.outputPreview,
                    })
                    break
                case 'QueueChanged':
                    s.queued = event.queued
                    break
                case 'UsageChanged':
                    s.usage = {
                        tokens: event.tokens ?? s.usage.tokens,
                        contextWindow:
                            event.contextWindow ?? s.usage.contextWindow,
                    }
                    break
                case 'MetaChanged':
                    s.meta = { ...s.meta, ...event.meta }
                    break
                case 'BackendError':
                    s.errorText = bounded(event.message)
                    break
            }
            bump(s)
            notify(s.id)
        }

        const spawn = (backendName: BackendName, task: SpawnTask) =>
            Effect.gen(function* () {
                const spawnActionSequence = ++actionSequence
                const taskName = normalizedTaskName(task.taskName ?? task.title)
                const ownedPaths = [
                    ...new Set(
                        (task.ownedPaths ?? [])
                            .map((value) => value.trim())
                            .filter(Boolean)
                            .map((value) => normalizeOwnedPath(task.cwd, value))
                    ),
                ]
                const overlappingEntries = [...entries.values()].filter(
                    (entry) =>
                        (pendingWork(entry) || entry.closing === true) &&
                        findOwnershipOverlap(
                            ownedPaths,
                            entry.snapshot.ownedPaths
                        )
                )
                const ownershipWarning =
                    overlappingEntries.length > 0
                        ? `Owned paths overlap with ${overlappingEntries.map((entry) => entry.snapshot.id).join(', ')}.`
                        : undefined
                const requestedRole = task.role?.trim()
                const unknownRole =
                    requestedRole && !isAgentRoleName(requestedRole)
                const role = isAgentRoleName(requestedRole)
                    ? resolveAgentRole(requestedRole).name
                    : resolveAgentRole().name
                // Reserve synchronously (before the first yield inside doSpawn) so
                // parallel tool calls cannot race past the global cap.
                yield* Effect.suspend(
                    (): Effect.Effect<
                        void,
                        SpawnError | ConcurrencyLimitError
                    > => {
                        if (disposed) {
                            return new SpawnError({
                                message: 'Subagent manager is shutting down.',
                            })
                        }
                        if (textBytes(task.prompt) > MAX_SPAWN_PROMPT_BYTES) {
                            return new SpawnError({
                                message: `Subagent prompt exceeds the ${MAX_SPAWN_PROMPT_BYTES}-byte limit.`,
                            })
                        }
                        if (unknownRole) {
                            return new SpawnError({
                                message: `Unknown subagent role "${requestedRole}".`,
                            })
                        }
                        const duplicateTask = [...entries.values()].some(
                            (entry) =>
                                entry.snapshot.taskName === taskName &&
                                (pendingWork(entry) || entry.closing === true)
                        )
                        if (duplicateTask || reservedTaskNames.has(taskName)) {
                            return new SpawnError({
                                message: `Active task name "${taskName}" is already in use.`,
                            })
                        }
                        if (runningCount() + reserved >= config.maxRunning) {
                            return new ConcurrencyLimitError({
                                message: `Max ${config.maxRunning} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
                            })
                        }
                        reserved++
                        reservedTaskNames.add(taskName)
                        return Effect.void
                    }
                )

                const doSpawn = Effect.gen(function* () {
                    const backend: SubagentBackend | undefined =
                        registry.get(backendName)
                    if (!backend) {
                        return yield* new BackendUnavailableError({
                            message: `Unknown backend "${backendName}".`,
                        })
                    }
                    const available = yield* backend.available
                    if (!available) {
                        return yield* new BackendUnavailableError({
                            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
                        })
                    }

                    const id = `sa-${++counter}`
                    const roleDefinition = resolveAgentRole(
                        role as Parameters<typeof resolveAgentRole>[0]
                    )
                    const execution = resolveAgentExecutionOptions({
                        role: roleDefinition,
                        roleModel:
                            config.roleModels[
                                roleDefinition.name as keyof typeof config.roleModels
                            ],
                        roleReasoningEffort:
                            config.roleReasoningEfforts[
                                roleDefinition.name as keyof typeof config.roleReasoningEfforts
                            ],
                        model: task.model,
                        reasoningEffort: task.reasoningEffort,
                        parentModel: task.parent.inheritedModel
                            ? `${task.parent.inheritedModel.provider}/${task.parent.inheritedModel.id}`
                            : undefined,
                        parentReasoningEffort: task.parent
                            .inheritedThinkingLevel as
                            import('./domain.ts').ReasoningEffort | undefined,
                    })
                    const initialRunId = `${id}:run-1`
                    const backendTask: SpawnTask = {
                        ...task,
                        agentId: id,
                        runId: initialRunId,
                        taskName,
                        role: roleDefinition.name,
                        model: execution.model,
                        reasoningEffort: execution.reasoningEffort,
                        allowedExtensionTools:
                            config.allowedExtensionTools?.[
                                roleDefinition.name as keyof NonNullable<
                                    SubagentConfig['allowedExtensionTools']
                                >
                            ],
                        ownedPaths,
                        reportToParent: (message) => {
                            publishMailbox({
                                agentId: id,
                                taskName,
                                role: roleDefinition.name,
                                kind: 'question',
                                text: boundedMailboxText(message),
                            })
                        },
                    }
                    const scope = yield* Scope.make()
                    const session = yield* Scope.provide(
                        backend.spawn(backendTask),
                        scope
                    ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
                    if (disposed) {
                        yield* Scope.close(scope, Exit.void)
                        return yield* new SpawnError({
                            message:
                                'Subagent manager shut down while spawning.',
                        })
                    }

                    const meta = yield* session.meta.pipe(
                        Effect.onError(() => closeScope(scope))
                    )
                    const entry: Entry = {
                        snapshot: {
                            id,
                            backend: backendName,
                            title: task.title,
                            taskName,
                            role,
                            version: 1,
                            transcriptVersion: 1,
                            currentRunId: initialRunId,
                            prompt: task.prompt,
                            ownedPaths,
                            ownershipWarning,
                            cwd: task.cwd,
                            status: 'running',
                            createdAt: Date.now(),
                            meta,
                            usage: { contextWindow: meta.contextWindow },
                            transcript: [],
                            lastRun: {
                                id: initialRunId,
                                agentId: id,
                                status: 'running',
                                startedAt: Date.now(),
                            },
                            liveTools: [],
                            queued: [],
                            finalText: '',
                            turns: 0,
                        },
                        session,
                        scope,
                        liveToolMap: new Map(),
                        nextRunNumber: 2,
                        pendingRunIds: new Set(),
                        runStartedAt: Date.now(),
                        spawnActionSequence,
                        lastActionSequence: spawnActionSequence,
                        closed: false,
                        closeIncomplete: false,
                        transcriptBytes: 0,
                    }
                    entries.set(id, entry)
                    metrics.agentsSpawned++
                    metrics.roles[roleDefinition.name] =
                        (metrics.roles[roleDefinition.name] ?? 0) + 1

                    // Pump: fold the event stream into the snapshot. Tied to the entry
                    // scope, so closing the scope stops it. If the stream ends while the
                    // subagent still looks running, the backend died out from under us.
                    const pump = Stream.runForEach(session.events, (event) =>
                        Effect.sync(() => foldEvent(entry, event))
                    ).pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                if (entry.snapshot.status === 'running')
                                    settle(entry, {
                                        _tag: 'Failed',
                                        errorText:
                                            'Backend event stream ended unexpectedly',
                                    })
                                if (entry.pendingRunIds.size > 0)
                                    failPendingRuns(
                                        entry,
                                        'Backend event stream ended before the queued run started'
                                    )
                            })
                        )
                    )
                    entry.pump = yield* Scope.provide(
                        Effect.forkScoped(pump),
                        scope
                    )

                    notify(id)
                    return entry.snapshot as SubagentSnapshot
                })

                return yield* doSpawn.pipe(
                    Effect.ensuring(
                        Effect.sync(() => {
                            reserved--
                            reservedTaskNames.delete(taskName)
                            notify()
                        })
                    )
                )
            })

        const waitFor = (
            ids: ReadonlyArray<string>,
            onPending?: (pending: string[]) => void,
            timeoutMs?: number
        ) =>
            Effect.suspend(() => {
                const unique = [...new Set(ids)]
                for (const id of unique) {
                    const entry = entries.get(id)
                    if (
                        entry &&
                        !entry.immediateWaitRecorded &&
                        pendingWork(entry) &&
                        entry.lastActionSequence === entry.spawnActionSequence
                    ) {
                        entry.immediateWaitRecorded = true
                        metrics.immediateWaits++
                    }
                }
                const pendingIds = () =>
                    unique.filter((id) => {
                        const entry = entries.get(id)
                        return entry !== undefined && pendingWork(entry)
                    })
                const currentResult = (timedOut: boolean) => {
                    const pending = pendingIds()
                    return {
                        completed: unique.filter((id) => !pending.includes(id)),
                        pending,
                        timedOut,
                    }
                }
                const collectResult = (result: Omit<WaitResult, 'events'>) => {
                    const runIds = result.completed
                        .map((id) => entries.get(id)?.snapshot.lastRun?.id)
                        .filter((runId): runId is string => runId !== undefined)
                    const events = mailbox.drain({
                        agentIds: unique,
                        runIds,
                    })
                    for (const event of events)
                        suppressedDeliveries.delete(event.sequence)
                    return { ...result, events }
                }
                addInterest(unique)
                const loop = Effect.gen(function* () {
                    while (true) {
                        // Queued follow-ups count as pending even after the previous
                        // run has settled and before the next RunStarted event arrives.
                        const pending = pendingIds()
                        if (pending.length === 0)
                            return collectResult(currentResult(false))
                        onPending?.(pending)
                        yield* nextChange
                    }
                })
                const waited =
                    timeoutMs === undefined
                        ? loop
                        : timeoutMs === 0
                          ? Effect.sync(() => {
                                const pending = pendingIds()
                                return collectResult(
                                    currentResult(pending.length > 0)
                                )
                            })
                          : loop.pipe(
                                Effect.timeout(timeoutMs),
                                Effect.result,
                                Effect.map((result) =>
                                    Result.isSuccess(result)
                                        ? result.success
                                        : collectResult(currentResult(true))
                                )
                            )
                return waited.pipe(
                    Effect.ensuring(
                        Effect.sync(() => {
                            releaseInterest(unique)
                            pruneSettled()
                        })
                    )
                )
            })

        /** Interrupt active work and discard follow-ups, force-closing after 5s. */
        const abortEntry = (entry: Entry) =>
            Effect.gen(function* () {
                if (!pendingWork(entry)) return
                const wasRunning = entry.snapshot.status === 'running'
                const restarting = entry.restarting === true
                const queuedRunId = entry.pendingRunIds.values().next().value
                entry.pendingRunIds.clear()
                const graceful = yield* entry.session.interrupt.pipe(
                    Effect.timeout(STOP_TIMEOUT_MS),
                    Effect.result
                )
                if (Result.isSuccess(graceful)) {
                    yield* Effect.sync(() => {
                        if (restarting && entry.restarting) {
                            // A queued idle restart has no RunStarted event to identify
                            // its run, so settle the visible restart explicitly.
                            settle(entry, { _tag: 'Interrupted' })
                            return
                        }
                        if (!wasRunning && queuedRunId) {
                            // The previous run is already terminal, but the backend
                            // has not emitted RunStarted for this queued run yet.
                            // Give the cancelled request a terminal run record without
                            // allowing a late start to resurrect the session.
                            if (
                                entry.snapshot.currentRunId !== queuedRunId ||
                                entry.snapshot.status !== 'running'
                            ) {
                                entry.snapshot.currentRunId = queuedRunId
                                entry.runStartedAt = Date.now()
                                entry.snapshot.status = 'running'
                                entry.snapshot.settledAt = undefined
                                entry.snapshot.lastRun = {
                                    id: queuedRunId,
                                    agentId: entry.snapshot.id,
                                    status: 'running',
                                    startedAt: entry.runStartedAt,
                                }
                            }
                            settle(entry, { _tag: 'Interrupted' }, queuedRunId)
                        }
                    })
                    return
                }

                // Settle before closing the scope so the pump's stream-ended
                // fallback cannot replace the requested abort reason.
                yield* Effect.sync(() => {
                    if (entry.snapshot.status === 'running')
                        settle(entry, { _tag: 'Interrupted' })
                    entry.snapshot.errorText =
                        'Abort deadline exceeded; session was force-disposed'
                    bump(entry.snapshot)
                    notify(entry.snapshot.id)
                })
                // Bound the close like disposeAll does: a stuck backend finalizer
                // must not hang cancel after the run is already settled.
                const forcedClose = yield* closeEntryScope(entry).pipe(
                    Effect.timeout(STOP_TIMEOUT_MS),
                    Effect.result
                )
                if (Result.isFailure(forcedClose)) entry.closeIncomplete = true
                entry.closed = true
                entry.snapshot.status = 'closed'
                entry.snapshot.settledAt ??= Date.now()
                entry.snapshot.queued = []
                bump(entry.snapshot)
                notify(entry.snapshot.id)
            })

        const interrupt = (ids: ReadonlyArray<string>) =>
            Effect.suspend(() => {
                const unique = [...new Set(ids)]
                const running = unique
                    .map((id) => entries.get(id))
                    .filter(
                        (entry): entry is Entry =>
                            entry !== undefined && pendingWork(entry)
                    )
                const runningIds = running.map((entry) => entry.snapshot.id)
                const interruptActionSequence = ++actionSequence
                for (const entry of running)
                    entry.lastActionSequence = interruptActionSequence
                const previousSequences = new Map(
                    running.map((entry) => [
                        entry.snapshot.id,
                        entry.lastSettlementSequence,
                    ])
                )
                // Suppress automatic delivery while the interrupt operation owns
                // terminal results. The exact settlement is consumed below.
                addInterest(runningIds)
                const work = Effect.gen(function* () {
                    yield* Effect.forEach(running, abortEntry, {
                        concurrency: 'unbounded',
                    })
                    while (running.some(pendingWork)) {
                        yield* nextChange
                    }
                    for (const entry of running) {
                        const sequence = entry.lastSettlementSequence
                        if (
                            sequence !== undefined &&
                            sequence !==
                                previousSequences.get(entry.snapshot.id)
                        ) {
                            mailbox.consume([sequence])
                            suppressedDeliveries.delete(sequence)
                        }
                    }
                })
                return work.pipe(
                    Effect.ensuring(
                        Effect.sync(() => {
                            releaseInterest(runningIds)
                            pruneSettled()
                        })
                    ),
                    Effect.map((): ReadonlyArray<CancelResult> =>
                        unique.map((id) => {
                            const snapshot = entries.get(id)?.snapshot
                            return {
                                id,
                                title: snapshot?.title ?? '?',
                                status: snapshot?.status ?? 'error',
                                cancelled: runningIds.includes(id),
                            }
                        })
                    )
                )
            })

        /** Backwards-compatible alias for interrupt. */
        const cancel = interrupt

        const close = (ids: ReadonlyArray<string>) =>
            Effect.suspend(() => {
                const unique = [...new Set(ids)]
                const entriesToClose = unique
                    .map((id) => entries.get(id))
                    .filter((entry): entry is Entry => entry !== undefined)
                const runningIds = entriesToClose
                    .filter(pendingWork)
                    .map((entry) => entry.snapshot.id)
                addInterest(runningIds)
                const closeResults = new Map<
                    string,
                    Pick<
                        CloseResult,
                        'terminal' | 'resourcesReleased' | 'error'
                    >
                >()
                const closeActionSequence = ++actionSequence
                for (const entry of entriesToClose) {
                    entry.lastActionSequence = closeActionSequence
                    if (!entry.closed) entry.closing = true
                }
                const work = Effect.forEach(
                    entriesToClose,
                    (entry) =>
                        Effect.gen(function* () {
                            if (entry.closed && entry.closeStatus) {
                                closeResults.set(entry.snapshot.id, {
                                    terminal: true,
                                    resourcesReleased:
                                        entry.closeStatus.resourcesReleased,
                                    ...(entry.closeStatus.error
                                        ? { error: entry.closeStatus.error }
                                        : {}),
                                })
                                return
                            }
                            const previousSequence =
                                entry.lastSettlementSequence
                            if (pendingWork(entry)) yield* abortEntry(entry)
                            const sessionClosed =
                                yield* entry.session.close.pipe(
                                    Effect.timeout(STOP_TIMEOUT_MS),
                                    Effect.result
                                )
                            const scopeClosed = yield* Scope.close(
                                entry.scope,
                                Exit.void
                            ).pipe(
                                Effect.timeout(STOP_TIMEOUT_MS),
                                Effect.result
                            )
                            const backendStatus: BackendCloseResult =
                                Result.isSuccess(sessionClosed)
                                    ? sessionClosed.success
                                    : {
                                          terminal: true,
                                          resourcesReleased: false,
                                          error: 'Backend close failed or timed out.',
                                      }
                            const errors = [
                                backendStatus.error,
                                ...(Result.isFailure(scopeClosed)
                                    ? [
                                          'Backend scope close failed or timed out.',
                                      ]
                                    : []),
                            ].filter((error): error is string => !!error)
                            const resourcesReleased =
                                backendStatus.resourcesReleased &&
                                Result.isSuccess(scopeClosed) &&
                                entry.closeIncomplete !== true
                            if (!resourcesReleased) entry.closeIncomplete = true
                            const closeStatus: BackendCloseResult = {
                                terminal: true,
                                resourcesReleased,
                                ...(errors.length > 0
                                    ? { error: errors.join('; ') }
                                    : {}),
                            }
                            entry.closeStatus = closeStatus
                            const sequence = entry.lastSettlementSequence
                            if (
                                sequence !== undefined &&
                                sequence !== previousSequence
                            ) {
                                mailbox.consume([sequence])
                                suppressedDeliveries.delete(sequence)
                            }
                            // Terminality is guaranteed even when cleanup is only
                            // best-effort; callers must not restart this session.
                            entry.closed = true
                            entry.closing = false
                            entry.snapshot.status = 'closed'
                            entry.snapshot.settledAt ??= Date.now()
                            entry.snapshot.queued = []
                            closeResults.set(entry.snapshot.id, closeStatus)
                            bump(entry.snapshot)
                            notify(entry.snapshot.id)
                        }),
                    { concurrency: 'unbounded' }
                )
                return work.pipe(
                    Effect.ensuring(
                        Effect.sync(() => {
                            releaseInterest(runningIds)
                            pruneSettled()
                        })
                    ),
                    Effect.map((): ReadonlyArray<CloseResult> =>
                        unique.map((id) => {
                            const snapshot = entries.get(id)?.snapshot
                            const result = closeResults.get(id)
                            return {
                                id,
                                title: snapshot?.title ?? '?',
                                status: snapshot?.status ?? 'error',
                                terminal: result?.terminal ?? false,
                                resourcesReleased:
                                    result?.resourcesReleased ?? false,
                                closed: result?.resourcesReleased ?? false,
                                ...(result?.error
                                    ? { error: result.error }
                                    : {}),
                            }
                        })
                    )
                )
            })

        const send = (
            id: string,
            text: string,
            delivery: SendDelivery = 'follow-up'
        ) =>
            Effect.suspend((): Effect.Effect<void, SendError> => {
                const entry = entries.get(id)
                if (!entry || disposed) {
                    return new SendError({
                        message: `Subagent "${id}" is no longer tracked.`,
                    })
                }
                if (entry.closed || entry.closing) {
                    return new SendError({
                        message: `Subagent "${id}" is permanently closed.`,
                    })
                }
                if (textBytes(text) > MAX_SEND_MESSAGE_BYTES) {
                    return new SendError({
                        message: `Subagent message exceeds the ${MAX_SEND_MESSAGE_BYTES}-byte limit.`,
                    })
                }
                entry.lastActionSequence = ++actionSequence
                // A restart becomes visibly running before dispatch. This lets cancel()
                // interrupt the narrow window before RunStarted reaches the event pump.
                if (!pendingWork(entry)) {
                    if (runningCount() + reserved >= config.maxRunning) {
                        return new SendError({
                            message: `Max ${config.maxRunning} subagents can run concurrently; restarting "${id}" would exceed that.`,
                        })
                    }
                    const snapshot = entry.snapshot
                    entry.restartState = {
                        status: snapshot.status,
                        settledAt: snapshot.settledAt,
                        errorText: snapshot.errorText,
                    }
                    entry.restarting = true
                    snapshot.status = 'running'
                    snapshot.settledAt = undefined
                    snapshot.errorText = undefined
                    const runId = `${id}:run-${entry.nextRunNumber++}`
                    entry.runStartedAt = Date.now()
                    snapshot.currentRunId = runId
                    snapshot.lastRun = {
                        id: runId,
                        agentId: snapshot.id,
                        status: 'running',
                        startedAt: entry.runStartedAt,
                    }
                    bump(snapshot)
                    notify(snapshot.id)
                    return entry.session.send(text, delivery, runId).pipe(
                        Effect.onError(() =>
                            Effect.sync(() => {
                                const previous = entry.restartState
                                entry.restarting = false
                                entry.restartState = undefined
                                if (previous) Object.assign(snapshot, previous)
                                bump(snapshot)
                                notify(snapshot.id)
                            })
                        )
                    )
                }
                const runId =
                    delivery === 'follow-up'
                        ? `${id}:run-${entry.nextRunNumber++}`
                        : undefined
                if (runId) entry.pendingRunIds.add(runId)
                return entry.session.send(text, delivery, runId).pipe(
                    Effect.onError(() =>
                        Effect.sync(() => {
                            if (runId) entry.pendingRunIds.delete(runId)
                            notify(entry.snapshot.id)
                        })
                    )
                )
            })

        const waitForMailbox = (options?: MailboxWaitOptions) =>
            mailbox.wait(options)

        const peekMailbox = (options: MailboxDrainOptions = {}) =>
            mailbox.peek(options)

        const ackMailbox = (sequences: Iterable<number>) => {
            mailbox.ack(sequences)
        }

        const drainMailbox = (options: MailboxDrainOptions = {}) =>
            mailbox.drain(options)

        const disposeAll = Effect.gen(function* () {
            disposed = true
            mailbox.close()
            const all = [...entries.values()]
            entries.clear()
            yield* Effect.forEach(
                all,
                (entry) =>
                    closeEntryScope(entry).pipe(
                        Effect.timeout(STOP_TIMEOUT_MS),
                        Effect.ignore
                    ),
                { concurrency: 'unbounded' }
            )
            // Pruning cleanups are detached; bound them like everything else so a
            // stuck backend finalizer cannot block runtime shutdown indefinitely.
            yield* Effect.forEach(
                [...cleanups],
                (fiber) =>
                    Fiber.await(fiber).pipe(
                        Effect.timeout(STOP_TIMEOUT_MS),
                        Effect.ignore
                    ),
                { concurrency: 'unbounded' }
            ).pipe(Effect.ignore)
            yield* Effect.sync(() => notify())
        })

        const view: SubagentReadModel = {
            list: () => [...entries.values()].map((entry) => entry.snapshot),
            get: (id) => entries.get(id)?.snapshot,
            size: () => entries.size,
            subscribe: (listener) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
            subscribeTo: (id, listener) => {
                let set = idListeners.get(id)
                if (!set) {
                    set = new Set()
                    idListeners.set(id, set)
                }
                set.add(listener)
                return () => {
                    set.delete(listener)
                    if (set.size === 0) idListeners.delete(id)
                }
            },
            requestSend: (id, text) => {
                runDetached(send(id, text).pipe(Effect.ignore))
            },
            requestAbort: (id) => {
                const entry = entries.get(id)
                if (!entry) return
                // UI-initiated aborts are not "consumed": the cancelled result still
                // flows back to the parent as a follow-up message.
                runDetached(abortEntry(entry).pipe(Effect.ignore))
            },
            requestClose: (id) => {
                runDetached(close([id]).pipe(Effect.ignore))
            },
            setOnSettled: (hook) => {
                onSettled = hook
            },
        }

        // Safety net: disposing the ManagedRuntime tears everything down even if
        // the extension forgot to call disposeAll explicitly.
        yield* Effect.addFinalizer(() => disposeAll)

        return SubagentManager.of({
            spawn,
            waitFor,
            interrupt,
            cancel,
            close,
            send,
            waitForMailbox,
            peekMailbox,
            claimMailbox: (options) => mailbox.claim(options),
            releaseMailbox: (sequences) => mailbox.release(sequences),
            ackMailbox,
            drainMailbox,
            setOnMailbox: (hook) => {
                onMailbox = hook
            },
            mailbox,
            get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
            list: Effect.sync(() =>
                [...entries.values()].map((e) => e.snapshot)
            ),
            disposeAll,
            getMetrics: () => ({
                agentsSpawned: metrics.agentsSpawned,
                immediateWaits: metrics.immediateWaits,
                roles: { ...metrics.roles },
            }),
            view,
        })
    })

export function makeSubagentManagerLayer(
    config: SubagentConfig = loadSubagentConfig()
): Layer.Layer<SubagentManager, never, BackendRegistry> {
    return Layer.effect(SubagentManager, makeManager(config))
}

export const SubagentManagerLive = makeSubagentManagerLayer()
