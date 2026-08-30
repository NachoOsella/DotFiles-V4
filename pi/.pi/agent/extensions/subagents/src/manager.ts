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

export const MAX_RUNNING = 8
export const MAX_TRACKED = 64
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
    lastMailboxSequence?: number
    prompt: string
    cwd: string
    status: SubagentStatus
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
    restartState?: Pick<MutableSnapshot, 'status' | 'settledAt' | 'errorText'>
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

export interface CancelResult {
    readonly id: string
    readonly title: string
    readonly status: SubagentStatus
    readonly cancelled: boolean
}

export interface MailboxDrainOptions {
    readonly agentIds?: ReadonlyArray<string>
    readonly afterSequence?: number
    readonly sequences?: ReadonlyArray<number>
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
        onPending?: (pending: string[]) => void
    ): Effect.Effect<void>
    /** Cancel running subagents; resolves when they have settled. */
    cancel(
        ids: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<CancelResult>>
    send(
        id: string,
        text: string,
        delivery?: SendDelivery
    ): Effect.Effect<void, SendError>
    /** Wait for mailbox activity without requiring a subagent id. */
    waitForMailbox(
        options?: MailboxWaitOptions
    ): Effect.Effect<MailboxWaitResult>
    /** Consume mailbox events, optionally only for selected subagents. */
    drainMailbox(options?: MailboxDrainOptions): ReadonlyArray<AgentEnvelope>
    /** Subscribe to newly published mailbox messages for parent delivery. */
    setOnMailbox(hook: ((envelope: AgentEnvelope) => void) | undefined): void
    /** The manager-owned mailbox. Prefer waitForMailbox/drainMailbox in tools. */
    readonly mailbox: AgentMailbox
    get(id: string): Effect.Effect<SubagentSnapshot | undefined>
    readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>
    readonly disposeAll: Effect.Effect<void>
    readonly view: SubagentReadModel
}

export class SubagentManager extends Context.Service<
    SubagentManager,
    SubagentManagerShape
>()('subagents/SubagentManager') {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
    const registry = yield* BackendRegistry
    // Detached forker for sync contexts (read-model commands, pruning) that
    // preserves the manager's services instead of using the global runtime.
    const runDetached = Effect.runForkWith(yield* Effect.context())

    const entries = new Map<string, Entry>()
    const mailbox = createAgentMailbox()
    const reservedTaskNames = new Set<string>()
    const waitInterest = new Map<string, number>()
    const listeners = new Set<() => void>()
    /** One-shot nextChange waiters, swapped out before invocation so waiters
     * re-registering during notification are not visited in the same sweep. */
    let changeWaiters: Array<() => void> = []
    const idListeners = new Map<string, Set<() => void>>()
    const cleanups = new Set<Fiber.Fiber<unknown>>()
    let counter = 0
    let reserved = 0
    let disposed = false
    let onSettled:
        ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined
    let onMailbox: ((envelope: AgentEnvelope) => void) | undefined

    const bump = (snapshot: MutableSnapshot) => {
        snapshot.version++
    }

    const appendTranscript = (entry: Entry, item: TranscriptItem) => {
        const boundedItem = boundedTranscriptItem(item)
        entry.snapshot.transcript.push(boundedItem)
        entry.transcriptBytes += transcriptItemBytes(boundedItem)
        while (
            entry.snapshot.transcript.length > 0 &&
            entry.transcriptBytes > MAX_TRANSCRIPT_BYTES
        ) {
            const removed = entry.snapshot.transcript.shift()
            if (removed) entry.transcriptBytes -= transcriptItemBytes(removed)
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

    const runningCount = () =>
        [...entries.values()].filter(
            (e) => e.snapshot.status === 'running' || e.restarting === true
        ).length

    const addInterest = (ids: ReadonlyArray<string>) => {
        for (const id of ids)
            waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1)
    }
    const releaseInterest = (ids: ReadonlyArray<string>) => {
        for (const id of ids) {
            const count = (waitInterest.get(id) ?? 1) - 1
            if (count <= 0) waitInterest.delete(id)
            else waitInterest.set(id, count)
        }
    }

    const closeEntryScope = (entry: Entry) =>
        Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)

    const pruneSettled = () => {
        if (entries.size <= MAX_TRACKED) return
        const candidates = [...entries.values()]
            .filter(
                (e) =>
                    e.snapshot.status !== 'running' &&
                    !waitInterest.has(e.snapshot.id)
            )
            .sort(
                (a, b) =>
                    (a.snapshot.settledAt ?? a.snapshot.createdAt) -
                    (b.snapshot.settledAt ?? b.snapshot.createdAt)
            )
        for (const entry of candidates) {
            if (entries.size <= MAX_TRACKED) break
            entries.delete(entry.snapshot.id)
            const fiber = runDetached(closeEntryScope(entry))
            cleanups.add(fiber)
            fiber.addObserver(() => cleanups.delete(fiber))
        }
    }

    const publishMailbox = (
        message: Parameters<AgentMailbox['publish']>[0]
    ) => {
        const envelope = mailbox.publish(message)
        if (!envelope) return undefined
        const entry = entries.get(envelope.agentId)
        if (entry) {
            entry.snapshot.lastMailboxSequence = envelope.sequence
            bump(entry.snapshot)
            notify(entry.snapshot.id)
        }
        try {
            onMailbox?.(envelope)
        } catch {
            // Parent delivery failures must not affect child lifecycle state.
        }
        return envelope
    }

    const settle = (entry: Entry, outcome: RunOutcome) => {
        const s = entry.snapshot
        entry.restarting = false
        entry.restartState = undefined
        if (s.status !== 'running') return
        s.settledAt = Date.now()
        switch (outcome._tag) {
            case 'Completed':
                s.status = 'done'
                s.errorText = undefined
                s.finalText = truncateUtf8(
                    outcome.finalText,
                    MAX_FINAL_TEXT_BYTES
                )
                break
            case 'Failed':
                s.status = 'error'
                s.errorText = bounded(outcome.errorText)
                // Never let a failed run report the previous run's successful output.
                s.finalText = truncateUtf8(
                    outcome.partialText ?? '',
                    MAX_FINAL_TEXT_BYTES
                )
                break
            case 'Interrupted':
                s.status = 'error'
                s.errorText = 'Run was aborted'
                s.finalText = truncateUtf8(
                    outcome.partialText ?? '',
                    MAX_FINAL_TEXT_BYTES
                )
                break
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
        if (!disposed) {
            publishMailbox({
                agentId: s.id,
                taskName: s.taskName,
                role: s.role,
                kind,
                text,
                deduplicationKey: `settlement:${s.id}:${s.turns}:${s.settledAt}`,
            })
        }
        const consumed = (waitInterest.get(s.id) ?? 0) > 0
        bump(s)
        notify(s.id)
        try {
            // During teardown, don't queue results into a shutting-down session.
            if (!disposed) onSettled?.(s, consumed)
        } catch {
            // The parent session may be unavailable; settlement stays final.
        }
        pruneSettled()
    }

    const foldEvent = (entry: Entry, event: SubagentEvent) => {
        const s = entry.snapshot
        switch (event._tag) {
            case 'RunStarted':
                entry.restarting = false
                entry.restartState = undefined
                s.status = 'running'
                s.settledAt = undefined
                s.errorText = undefined
                break
            case 'RunSettled':
                // An idle restart can be queued while the prior turn's terminal event
                // is still in flight. Do not let that stale event settle the restart.
                if (!entry.restarting) settle(entry, event.outcome)
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
                    contextWindow: event.contextWindow ?? s.usage.contextWindow,
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
            const taskName = normalizedTaskName(task.taskName ?? task.title)
            const requestedRole = task.role?.trim()
            const unknownRole = requestedRole && !isAgentRoleName(requestedRole)
            const role = isAgentRoleName(requestedRole)
                ? resolveAgentRole(requestedRole).name
                : resolveAgentRole().name
            // Reserve synchronously (before the first yield inside doSpawn) so
            // parallel tool calls cannot race past the global cap.
            yield* Effect.suspend(
                (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
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
                            (entry.snapshot.status === 'running' ||
                                entry.restarting)
                    )
                    if (duplicateTask || reservedTaskNames.has(taskName)) {
                        return new SpawnError({
                            message: `Active task name "${taskName}" is already in use.`,
                        })
                    }
                    if (runningCount() + reserved >= MAX_RUNNING) {
                        return new ConcurrencyLimitError({
                            message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
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
                    model: task.model,
                    reasoningEffort: task.reasoningEffort,
                    parentModel: task.parent.inheritedModel
                        ? `${task.parent.inheritedModel.provider}/${task.parent.inheritedModel.id}`
                        : undefined,
                    parentReasoningEffort: task.parent
                        .inheritedThinkingLevel as
                        import('./domain.ts').ReasoningEffort | undefined,
                })
                const backendTask: SpawnTask = {
                    ...task,
                    agentId: id,
                    taskName,
                    role: roleDefinition.name,
                    model: execution.model,
                    reasoningEffort: execution.reasoningEffort,
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
                        message: 'Subagent manager shut down while spawning.',
                    })
                }

                const meta = yield* session.meta
                const entry: Entry = {
                    snapshot: {
                        id,
                        backend: backendName,
                        title: task.title,
                        taskName,
                        role,
                        version: 1,
                        prompt: task.prompt,
                        cwd: task.cwd,
                        status: 'running',
                        createdAt: Date.now(),
                        meta,
                        usage: { contextWindow: meta.contextWindow },
                        transcript: [],
                        liveTools: [],
                        queued: [],
                        finalText: '',
                        turns: 0,
                    },
                    session,
                    scope,
                    liveToolMap: new Map(),
                    transcriptBytes: 0,
                }
                entries.set(id, entry)

                // Pump: fold the event stream into the snapshot. Tied to the entry
                // scope, so closing the scope stops it. If the stream ends while the
                // subagent still looks running, the backend died out from under us.
                const pump = Stream.runForEach(session.events, (event) =>
                    Effect.sync(() => foldEvent(entry, event))
                ).pipe(
                    Effect.ensuring(
                        Effect.sync(() => {
                            if (entry.snapshot.status === 'running') {
                                settle(entry, {
                                    _tag: 'Failed',
                                    errorText:
                                        'Backend event stream ended unexpectedly',
                                })
                            }
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
        onPending?: (pending: string[]) => void
    ) =>
        Effect.suspend(() => {
            const unique = [...new Set(ids)]
            addInterest(unique)
            const loop = Effect.gen(function* () {
                while (true) {
                    // An idle subagent being restarted (send on a settled entry) counts
                    // as pending until its RunStarted flips the snapshot to running;
                    // otherwise a wait issued right after send could return too early.
                    const pending = unique.filter((id) => {
                        const entry = entries.get(id)
                        return (
                            entry?.snapshot.status === 'running' ||
                            entry?.restarting === true
                        )
                    })
                    if (pending.length === 0) return
                    onPending?.(pending)
                    yield* nextChange
                }
            })
            return loop.pipe(
                Effect.ensuring(
                    Effect.sync(() => {
                        releaseInterest(unique)
                        pruneSettled()
                    })
                )
            )
        })

    /** Interrupt one running entry, force-closing its scope after 5s. */
    const abortEntry = (entry: Entry) =>
        Effect.gen(function* () {
            if (entry.snapshot.status !== 'running') return
            const restarting = entry.restarting === true
            const graceful = yield* entry.session.interrupt.pipe(
                Effect.timeout(STOP_TIMEOUT_MS),
                Effect.result
            )
            if (Result.isSuccess(graceful) && restarting && entry.restarting) {
                // A queued idle restart has no RunStarted event to identify its run.
                // Settle it here after the backend clears the queued prompt.
                yield* Effect.sync(() => {
                    settle(entry, { _tag: 'Interrupted' })
                })
                return
            }
            if (Result.isFailure(graceful)) {
                // Settle before closing the scope so the pump's stream-ended
                // fallback ("Backend event stream ended unexpectedly") cannot win
                // the race and report the wrong terminal reason.
                yield* Effect.sync(() => {
                    settle(entry, { _tag: 'Interrupted' })
                    entry.snapshot.errorText =
                        'Abort deadline exceeded; session was force-disposed'
                    bump(entry.snapshot)
                    notify(entry.snapshot.id)
                })
                // Bound the close like disposeAll does: a stuck backend finalizer
                // must not hang cancel after the run is already settled.
                yield* closeEntryScope(entry).pipe(
                    Effect.timeout(STOP_TIMEOUT_MS),
                    Effect.ignore
                )
            }
        })

    const cancel = (ids: ReadonlyArray<string>) =>
        Effect.suspend(() => {
            const unique = [...new Set(ids)]
            const running = unique
                .map((id) => entries.get(id))
                .filter(
                    (entry): entry is Entry =>
                        entry?.snapshot.status === 'running'
                )
            const runningIds = running.map((entry) => entry.snapshot.id)
            // Mark consumed before interrupting so cancellation does not also
            // enqueue duplicate automatic result messages into the parent.
            addInterest(runningIds)
            const work = Effect.gen(function* () {
                yield* Effect.forEach(running, abortEntry, {
                    concurrency: 'unbounded',
                })
                while (
                    running.some((entry) => entry.snapshot.status === 'running')
                ) {
                    yield* nextChange
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

    const send = (id: string, text: string, delivery: SendDelivery = 'steer') =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
            const entry = entries.get(id)
            if (!entry || disposed) {
                return new SendError({
                    message: `Subagent "${id}" is no longer tracked.`,
                })
            }
            if (textBytes(text) > MAX_SEND_MESSAGE_BYTES) {
                return new SendError({
                    message: `Subagent message exceeds the ${MAX_SEND_MESSAGE_BYTES}-byte limit.`,
                })
            }
            // A restart becomes visibly running before dispatch. This lets cancel()
            // interrupt the narrow window before RunStarted reaches the event pump.
            if (entry.snapshot.status !== 'running') {
                if (runningCount() + reserved >= MAX_RUNNING) {
                    return new SendError({
                        message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
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
                bump(snapshot)
                notify(snapshot.id)
                return entry.session.send(text, delivery).pipe(
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
            return entry.session.send(text, delivery)
        })

    const waitForMailbox = (options?: MailboxWaitOptions) =>
        mailbox.wait(options)

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
            // UI-initiated aborts are not "consumed": the failed result still
            // flows back to the parent as a follow-up message, matching v1.
            runDetached(abortEntry(entry).pipe(Effect.ignore))
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
        cancel,
        send,
        waitForMailbox,
        drainMailbox,
        setOnMailbox: (hook) => {
            onMailbox = hook
        },
        mailbox,
        get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
        list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
        disposeAll,
        view,
    })
})

export const SubagentManagerLive: Layer.Layer<
    SubagentManager,
    never,
    BackendRegistry
> = Layer.effect(SubagentManager, makeManager)
