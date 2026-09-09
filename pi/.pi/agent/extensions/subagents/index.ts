/**
 * Subagents — spawn background pi subagents through a single Effect service.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, working_dir, model,
 *   reasoning_effort). Default max 8 running at once; configurable by environment.
 * - subagent_send: steer or queue a concise child instruction.
 * - subagent_wait: wait for children or mailbox activity.
 * - subagent_cancel: compatibility alias for interrupting subagents.
 * - subagent_interrupt: interrupt runs while keeping sessions reusable.
 * - subagent_close: permanently close subagents and release resources.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 * Subagents are conversationally isolated, not OS-level sandboxes.
 *
 * Architecture: Effect v4 generators throughout (pi backend -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import type {
    ExtensionAPI,
    ExtensionUIContext,
} from '@earendil-works/pi-coding-agent'
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    getAgentDir,
    getMarkdownTheme,
    keyHint,
    ProjectTrustStore,
    truncateHead,
} from '@earendil-works/pi-coding-agent'
import { Markdown, Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import {
    formatElapsed,
    formatModelWithThinking,
    latestText,
    REASONING_EFFORTS,
    type SubagentSnapshot,
} from './src/domain.ts'
import {
    countSubagentStates,
    formatActivityStatus,
    formatContextUtilization,
} from './src/format.ts'
import { deliverMailbox as deliverMailboxToParent } from './src/delivery.ts'
import { SubagentManager, type SubagentManagerShape } from './src/manager.ts'
import type { AgentEnvelope } from './src/mailbox.ts'
import { AGENT_ROLE_NAMES } from './src/roles.ts'
import {
    buildMailboxMessage,
    buildSubagentSpawnResult,
    SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
    SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    SUBAGENT_CLOSE_PARAMETER_DESCRIPTIONS,
    SUBAGENT_CLOSE_TOOL_DESCRIPTION,
    SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
    SUBAGENT_CHECK_TOOL_DESCRIPTION,
    SUBAGENT_LIST_TOOL_DESCRIPTION,
    SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
    SUBAGENT_SEND_TOOL_DESCRIPTION,
    SUBAGENT_INTERRUPT_PARAMETER_DESCRIPTIONS,
    SUBAGENT_INTERRUPT_TOOL_DESCRIPTION,
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
    SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    SUBAGENT_SPAWN_PROMPT_SNIPPET,
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from './src/prompt.ts'
import {
    createSubagentRuntime,
    runTool,
    type SubagentRuntime,
} from './src/runtime.ts'
import { openSubagentPicker } from './src/ui/takeover.ts'

const SUBAGENT_OUTPUT_MAX_BYTES = 8 * 1024
const WAIT_OUTPUT_MAX_BYTES = 32 * 1024
const WAIT_PER_AGENT_MAX_BYTES = 8 * 1024
const WAIT_MANIFEST_MAX_BYTES = 4 * 1024
const WAIT_OMISSION_MAX_BYTES = 4 * 1024
const WAIT_TRUNCATION_RESERVE_BYTES = 1024
const CHECK_PREVIEW_MAX_BYTES = 1024
const DELIVERY_BATCH_MS = 100

function utf8Bytes(text: string) {
    return Buffer.byteLength(text, 'utf8')
}

/** Truncate UTF-8 without splitting a code point. */
function truncateUtf8Bytes(text: string, maxBytes: number) {
    if (maxBytes <= 0) return ''
    if (utf8Bytes(text) <= maxBytes) return text
    let bytes = 0
    let out = ''
    for (const character of text) {
        const size = utf8Bytes(character)
        if (bytes + size > maxBytes) break
        out += character
        bytes += size
    }
    return out
}

function boundMetaText(text: string, maxBytes: number) {
    if (utf8Bytes(text) <= maxBytes) return text
    const marker = '…'
    const markerBytes = utf8Bytes(marker)
    if (maxBytes <= markerBytes) return truncateUtf8Bytes(text, maxBytes)
    return `${truncateUtf8Bytes(text, maxBytes - markerBytes)}${marker}`
}

function retrievalRoute(snap: SubagentSnapshot | undefined) {
    if (!snap) return 'no transcript file available'
    return snap.meta.sessionFilePath
        ? `session transcript: ${snap.meta.sessionFilePath}`
        : 'no transcript file available'
}

/**
 * Conservative cursor for filtered waits. Never advance past the earliest
 * still-undelivered sequence so a global cursor cannot silently skip an
 * in-flight event that later releases. Retained events stay consumable by a
 * future wait with the returned cursor.
 */
function conservativeNextSequence(
    requestedAfter: number,
    events: ReadonlyArray<AgentEnvelope>,
    earliestUndelivered: number | undefined
) {
    if (events.length === 0) return requestedAfter
    const maxReturned = Math.max(...events.map((event) => event.sequence))
    if (
        earliestUndelivered !== undefined &&
        earliestUndelivered < maxReturned
    ) {
        return Math.max(0, earliestUndelivered - 1)
    }
    return maxReturned
}

function boundOutputWithNotice(body: string, maxBytes: number) {
    if (utf8Bytes(body) <= maxBytes) return body
    const notice = `\n\n[Output truncated: showing partial output within ${formatSize(maxBytes)} budget. Use subagent_check for per-child status or the session transcript path listed for each child for full output.]`
    const available = Math.max(0, maxBytes - utf8Bytes(notice))
    return `${truncateUtf8Bytes(body, available)}${notice}`
}

function buildWaitManifest(
    ids: ReadonlyArray<string>,
    getSnap: (id: string) => SubagentSnapshot | undefined
) {
    const parts = ids.map((id) => {
        const snap = getSnap(id)
        if (!snap) return `${boundMetaText(id, 128)} (unknown)`
        const task = boundMetaText(snap.taskName ?? snap.title ?? '?', 128)
        const role = boundMetaText(snap.role ?? 'default', 64)
        return `${snap.id} ${task} (${role}; ${snap.status})`
    })
    const manifest = `Requested ${ids.length} subagent(s): ${parts.join(', ')}`
    if (utf8Bytes(manifest) <= WAIT_MANIFEST_MAX_BYTES) return manifest
    // Manifest must name every requested ID; bound per-ID fields already, so
    // fall back to IDs only rather than dropping any child.
    const idsOnly = `Requested ${ids.length} subagent(s): ${ids.map((id) => boundMetaText(id, 128)).join(', ')}`
    return truncateUtf8Bytes(idsOnly, WAIT_MANIFEST_MAX_BYTES)
}

function buildOmissionNotice(
    omitted: ReadonlyArray<{ id: string; retrieval: string }>,
    total: number
) {
    if (omitted.length === 0) return undefined
    const listed = omitted
        .map(
            (entry) =>
                `${boundMetaText(entry.id, 128)} (${boundMetaText(entry.retrieval, 256)})`
        )
        .join(', ')
    const notice = `Omitted ${omitted.length} of ${total} requested subagent(s) from displayed output to stay within ${formatSize(WAIT_OUTPUT_MAX_BYTES)} budget: ${listed}. Retrieve each omitted child via subagent_check or its session transcript path above; when no transcript file exists the notice says so.`
    if (utf8Bytes(notice) <= WAIT_OMISSION_MAX_BYTES) return notice
    const idsOnly = `Omitted ${omitted.length} of ${total} requested subagent(s) from displayed output to stay within ${formatSize(WAIT_OUTPUT_MAX_BYTES)} budget: ${omitted.map((entry) => boundMetaText(entry.id, 128)).join(', ')}. Retrieve each omitted child via subagent_check or its session transcript path.`
    return truncateUtf8Bytes(idsOnly, WAIT_OMISSION_MAX_BYTES)
}

function describeSubagent(snap: SubagentSnapshot) {
    const details = [
        `${snap.backend}: ${formatModelWithThinking(snap.meta)}`,
        formatContextUtilization(snap.usage),
        formatElapsed(snap),
        snap.cwd,
    ].filter(Boolean)
    return `${snap.id} [${snap.status}] ${snap.taskName ?? snap.title} (${snap.role ?? 'default'}; ${details.join(', ')})`
}

function truncatedOutput(
    snap: SubagentSnapshot,
    maxBytes = SUBAGENT_OUTPUT_MAX_BYTES
): string {
    const output = snap.finalText || '(no output)'
    const truncation = truncateHead(output, {
        maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
        maxLines: Math.min(600, DEFAULT_MAX_LINES),
    })
    let text = truncation.content
    if (truncation.truncated) {
        text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? '?'}]`
    }
    return text
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
    parentCwd: string
    childCwd: string
    parentTrusted: boolean
}) {
    if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
        return options.parentTrusted
    }
    try {
        const trustStore = new ProjectTrustStore(getAgentDir())
        return trustStore.get(options.childCwd) === true
    } catch {
        return false
    }
}

export interface SubagentsExtensionOptions {
    /** Runtime factory used by integration tests and host-specific embeddings. */
    readonly createRuntime?: () => SubagentRuntime
}

export function createSubagentsExtension(
    pi: ExtensionAPI,
    options: SubagentsExtensionOptions = {}
) {
    let runtime: SubagentRuntime | undefined
    let managerPromise: Promise<SubagentManagerShape> | undefined
    let ui: ExtensionUIContext | undefined
    let unsubStatus: (() => void) | undefined
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined
    let deliveryDueAt: number | undefined
    let deliveryInFlight: Promise<void> = Promise.resolve()
    let deliveryStopped = false
    const deliveryAttempts = new Map<number, number>()

    const getRuntime = () =>
        (runtime ??= options.createRuntime?.() ?? createSubagentRuntime())

    /** Resolve the manager service once per runtime and wire the extension hooks. */
    const getManager = () => {
        managerPromise ??= getRuntime()
            .runPromise(SubagentManager)
            .then((manager) => {
                manager.setOnMailbox(onMailbox)
                manager.view.setOnSettled((_snapshot, consumed) => {
                    if (!consumed) scheduleMailboxDelivery()
                })
                unsubStatus?.()
                unsubStatus = manager.view.subscribe(() =>
                    updateStatus(manager)
                )
                updateStatus(manager)
                return manager
            })
        return managerPromise
    }

    const updateStatus = (manager: SubagentManagerShape) => {
        if (!ui) return
        const subs = manager.view.list()
        if (subs.length === 0) {
            ui.setStatus('subagents', undefined)
            return
        }
        // Same buckets as the dashboard summary: closed is not failure and
        // interruption is distinct from failure via lastRun.status.
        const hasPendingQuestion = (id: string) =>
            manager
                .peekMailbox({ agentIds: [id] })
                .some((envelope) => envelope.kind === 'question')
        const counts = countSubagentStates(subs, hasPendingQuestion)
        ui.setStatus(
            'subagents',
            formatActivityStatus(ui.theme, {
                running: counts.running,
                queued: counts.queued,
                done: counts.done,
                failed: counts.failed,
                interrupted: counts.interrupted,
                closed: counts.closed,
            })
        )
    }

    const deliverMailbox = (
        manager: SubagentManagerShape,
        sequences?: ReadonlyArray<number>
    ) => {
        const operation = () =>
            deliverMailboxToParent(
                manager,
                (message, options) => pi.sendMessage(message, options),
                deliveryAttempts,
                sequences
            )
        const result = deliveryInFlight.then(operation, operation)
        // Keep later deliveries serialized even if a host delivery rejects.
        deliveryInFlight = result.then(
            () => undefined,
            () => undefined
        )
        return result
    }

    const flushMailbox = () => {
        deliveryTimer = undefined
        deliveryDueAt = undefined
        if (deliveryStopped) return
        void getManager()
            .then(async (manager) => {
                if (deliveryStopped) return
                try {
                    const result = await deliverMailbox(manager)
                    if (!deliveryStopped && !result.delivered && result.retry)
                        scheduleMailboxDelivery(result.retryAfterMs)
                } catch {
                    // A disposed runtime or host failure must not produce an
                    // unhandled rejection; never retry against disposal.
                    if (deliveryStopped) return
                }
            })
            .catch(() => {
                // getManager failed (runtime disposed during shutdown).
            })
    }

    const scheduleMailboxDelivery = (delayMs = DELIVERY_BATCH_MS) => {
        if (deliveryStopped) return
        const dueAt = Date.now() + Math.max(0, delayMs)
        if (deliveryTimer && deliveryDueAt !== undefined) {
            if (deliveryDueAt <= dueAt) return
            clearTimeout(deliveryTimer)
        }
        deliveryDueAt = dueAt
        deliveryTimer = setTimeout(flushMailbox, Math.max(0, delayMs))
    }

    const onMailbox = (envelope: AgentEnvelope) => {
        if (deliveryStopped) return
        void getManager()
            .then(async (manager) => {
                if (deliveryStopped) return
                try {
                    if (envelope.kind === 'question') {
                        if (deliveryTimer) clearTimeout(deliveryTimer)
                        deliveryTimer = undefined
                        deliveryDueAt = undefined
                        const result = await deliverMailbox(manager)
                        if (deliveryStopped) return
                        if (!result.delivered && result.retry)
                            scheduleMailboxDelivery(result.retryAfterMs)
                        else if (result.delivered) scheduleMailboxDelivery()
                        return
                    }
                    scheduleMailboxDelivery()
                } catch {
                    // Detached delivery must never produce an unhandled
                    // rejection and must not retry against a disposed runtime.
                    if (deliveryStopped) return
                }
            })
            .catch(() => {
                // getManager failed (runtime disposed during shutdown).
            })
    }

    pi.on('session_start', (_event, ctx) => {
        deliveryStopped = false
        if (ctx.hasUI) ui = ctx.ui
    })

    pi.on('session_shutdown', async () => {
        deliveryStopped = true
        if (deliveryTimer) clearTimeout(deliveryTimer)
        deliveryTimer = undefined
        deliveryDueAt = undefined
        deliveryAttempts.clear()
        unsubStatus?.()
        unsubStatus = undefined
        ui?.setStatus('subagents', undefined)
        const closing = runtime
        runtime = undefined
        managerPromise = undefined
        // Disposing the runtime runs the manager finalizer, which tears down all
        // subagent scopes (and, later, their real child processes).
        await closing?.dispose()
    })

    // --- Tools -------------------------------------------------------------

    pi.registerTool({
        name: 'subagent_spawn',
        label: 'Spawn Subagent',
        description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
        promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
        promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
        parameters: Type.Object({
            prompt: Type.String({
                description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
            }),
            name: Type.String({
                description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
            }),
            task_name: Type.Optional(
                Type.String({
                    description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.taskName,
                })
            ),
            agent_type: Type.Optional(
                StringEnum(AGENT_ROLE_NAMES, {
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.agentType,
                })
            ),
            working_dir: Type.Optional(
                Type.String({
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
                })
            ),
            model: Type.Optional(
                Type.String({
                    description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
                })
            ),
            reasoning_effort: Type.Optional(
                StringEnum(REASONING_EFFORTS, {
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
                })
            ),
            owned_paths: Type.Optional(
                Type.Array(Type.String(), {
                    maxItems: 64,
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.ownedPaths,
                })
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const manager = await getManager()
            const cwd = path.resolve(ctx.cwd, params.working_dir ?? '.')
            if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
                throw new Error(`working_dir is not a directory: ${cwd}`)
            }

            const title = params.name.trim().slice(0, 160) || 'subagent'
            const snap = await runTool(
                getRuntime(),
                manager.spawn('pi', {
                    prompt: params.prompt,
                    title,
                    taskName: params.task_name,
                    role: params.agent_type,
                    cwd,
                    model: params.model,
                    reasoningEffort: params.reasoning_effort,
                    ownedPaths: params.owned_paths
                        ?.map((value) => value.trim())
                        .filter(Boolean)
                        .map((value) => path.resolve(cwd, value)),
                    parent: {
                        parentCwd: ctx.cwd,
                        parentSession: ctx.sessionManager.getSessionFile(),
                        projectTrusted: resolveChildProjectTrust({
                            parentCwd: ctx.cwd,
                            childCwd: cwd,
                            parentTrusted: ctx.isProjectTrusted(),
                        }),
                        inheritedModel: ctx.model
                            ? { provider: ctx.model.provider, id: ctx.model.id }
                            : undefined,
                        inheritedThinkingLevel: pi.getThinkingLevel(),
                        modelRegistry: ctx.modelRegistry,
                    },
                }),
                {
                    signal,
                    interruptMessage: 'Subagent spawn aborted.',
                }
            )

            return {
                content: [
                    {
                        type: 'text',
                        text: buildSubagentSpawnResult({
                            id: snap.id,
                            taskName: snap.taskName ?? snap.title,
                            role: snap.role ?? 'default',
                            modelLabel: formatModelWithThinking(snap.meta),
                            ownershipWarning: snap.ownershipWarning,
                        }),
                    },
                ],
                details: {
                    id: snap.id,
                    taskName: snap.taskName,
                    role: snap.role,
                    cwd,
                    model: formatModelWithThinking(snap.meta),
                    owned_paths: snap.ownedPaths,
                    ownership_warning: snap.ownershipWarning,
                },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_wait',
        label: 'Wait for Subagents',
        description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
        parameters: Type.Object({
            ids: Type.Optional(
                Type.Array(Type.String(), {
                    maxItems: 64,
                    description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
                })
            ),
            after_sequence: Type.Optional(
                Type.Integer({
                    minimum: 0,
                    description:
                        SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.afterSequence,
                })
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate) {
            const manager = await getManager()
            const ids = [...new Set(params.ids ?? [])]
            if (ids.length === 0) {
                const result = await runTool(
                    getRuntime(),
                    manager.waitForMailbox({
                        afterSequence: params.after_sequence,
                    }),
                    { signal, interruptMessage: 'Mailbox wait aborted.' }
                )
                for (const event of result.events)
                    deliveryAttempts.delete(event.sequence)
                // Aggregate byte limit: a per-envelope cap is not enough when
                // many events are combined. Truncate with an explicit notice
                // (never present a displayed subset as complete) while keeping
                // the full events in details. UTF-8 safe and within budget.
                const mailboxText =
                    result.events.length > 0
                        ? boundOutputWithNotice(
                              buildMailboxMessage(result.events),
                              WAIT_OUTPUT_MAX_BYTES
                          )
                        : 'No new subagent messages.'
                return {
                    content: [
                        {
                            type: 'text',
                            text: mailboxText,
                        },
                    ],
                    details: {
                        events: result.events,
                        next_sequence: result.nextSequence,
                        timed_out: result.timedOut,
                    },
                }
            }

            const known = manager.view.list().map((snap) => snap.id)
            const unknown = ids.filter((id) => !manager.view.get(id))
            if (unknown.length > 0) {
                throw new Error(
                    `Unknown subagent id(s): ${unknown.join(', ')}. Known: ${known.join(', ') || 'none'}.`
                )
            }
            const requestedAfterSequence = params.after_sequence ?? 0
            const waitResult = await runTool(
                getRuntime(),
                manager.waitFor(
                    ids,
                    (pending) => {
                        onUpdate?.({
                            content: [
                                {
                                    type: 'text',
                                    text: `Waiting for ${pending.join(', ')}...`,
                                },
                            ],
                            details: { pending },
                        })
                    },
                    undefined,
                    requestedAfterSequence
                ),
                {
                    signal,
                    interruptMessage: 'Wait aborted. Subagents keep running.',
                }
            )

            const events = waitResult.events
            for (const event of events) deliveryAttempts.delete(event.sequence)
            // Conservative cursor: never advance past the earliest
            // still-undelivered sequence so a future global wait cannot
            // silently skip an in-flight event. Retained events stay
            // consumable with the returned cursor.
            const earliestUndelivered =
                manager.mailbox.earliestUndeliveredSequence()
            const nextSequence = conservativeNextSequence(
                requestedAfterSequence,
                events,
                earliestUndelivered
            )
            const wakeEvents = events.filter(
                (event) => event.kind === 'question' || event.kind === 'update'
            )
            const earlyWake =
                wakeEvents.length > 0 && waitResult.pending.length > 0
            // Reserve bytes for the all-requested-IDs manifest and an omission
            // notice before adding response bodies, so a displayed subset is
            // never presented as the complete result.
            const manifest = buildWaitManifest(ids, (id) =>
                manager.view.get(id)
            )
            let bodiesBudget =
                WAIT_OUTPUT_MAX_BYTES -
                utf8Bytes(manifest) -
                WAIT_OMISSION_MAX_BYTES -
                WAIT_TRUNCATION_RESERVE_BYTES
            if (bodiesBudget < 512) bodiesBudget = 512
            let remainingBytes = bodiesBudget
            const takeBounded = (raw: string) => {
                if (utf8Bytes(raw) <= remainingBytes) {
                    remainingBytes -= utf8Bytes(raw) + 2
                    return raw
                }
                const truncated = boundOutputWithNotice(raw, remainingBytes)
                remainingBytes = 0
                return truncated
            }
            const rawWakeMessage =
                wakeEvents.length > 0
                    ? buildMailboxMessage(wakeEvents)
                    : undefined
            const wakeMessage =
                rawWakeMessage !== undefined
                    ? takeBounded(rawWakeMessage)
                    : undefined
            const gapWarnings = events
                .filter((event) => event.kind === 'gap')
                .map((event) => boundMetaText(event.text, 1024))
            const rawGapWarning =
                gapWarnings.length > 0
                    ? `Mailbox warning:\n${gapWarnings.join('\n')}`
                    : undefined
            const gapWarning =
                rawGapWarning !== undefined
                    ? takeBounded(rawGapWarning)
                    : undefined
            const sections: string[] = []
            const omitted: Array<{ id: string; retrieval: string }> = []
            if (!earlyWake) {
                for (const id of ids) {
                    const snap = manager.view.get(id)
                    if (!snap) {
                        omitted.push({
                            id,
                            retrieval: 'no transcript file available',
                        })
                        continue
                    }
                    const header = `## ${boundMetaText(snap.id, 128)} ${boundMetaText(snap.taskName ?? snap.title ?? '?', 256)} (${boundMetaText(snap.role ?? 'default', 64)})`
                    const errorPart = snap.errorText
                        ? `\nError: ${boundMetaText(snap.errorText, 1024)}`
                        : ''
                    const base = `${header}${errorPart}`
                    const baseBytes = utf8Bytes(base)
                    if (baseBytes + 2 > remainingBytes) {
                        omitted.push({ id, retrieval: retrievalRoute(snap) })
                        continue
                    }
                    const budget = Math.max(
                        512,
                        Math.min(
                            WAIT_PER_AGENT_MAX_BYTES,
                            remainingBytes - baseBytes - 2
                        )
                    )
                    const section = `${base}\n\n${truncatedOutput(snap, budget)}`
                    if (utf8Bytes(section) > remainingBytes) {
                        omitted.push({ id, retrieval: retrievalRoute(snap) })
                        continue
                    }
                    sections.push(section)
                    remainingBytes -= utf8Bytes(section) + 8
                }
            }
            // Early wakes stay concise by design (no per-child bodies) and
            // keep the blocking question or latest update first so existing
            // `^Subagent` expectations hold; the manifest still names every
            // requested ID so the displayed subset is never presented as complete.
            const omissionNotice = earlyWake
                ? undefined
                : buildOmissionNotice(omitted, ids.length)
            const stillRunning = `Still running: ${waitResult.pending.join(', ')}`
            const body = earlyWake
                ? [wakeMessage, stillRunning, gapWarning, manifest]
                      .filter(
                          (section): section is string => section !== undefined
                      )
                      .join('\n\n')
                : [
                      wakeMessage,
                      gapWarning,
                      ...sections,
                      manifest,
                      omissionNotice,
                  ]
                      .filter(
                          (section): section is string => section !== undefined
                      )
                      .join('\n\n---\n\n')
            const boundedText = boundOutputWithNotice(
                body,
                WAIT_OUTPUT_MAX_BYTES
            )
            return {
                content: [{ type: 'text', text: boundedText }],
                details: {
                    events,
                    next_sequence: nextSequence,
                    timed_out: waitResult.timedOut,
                    pending: waitResult.pending,
                    completed: waitResult.completed,
                    results: ids.map((id) => {
                        const snap = manager.view.get(id)
                        return {
                            id,
                            taskName: snap?.taskName,
                            role: snap?.role,
                            status: snap?.status,
                        }
                    }),
                },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_send',
        label: 'Send to Subagent',
        description: SUBAGENT_SEND_TOOL_DESCRIPTION,
        parameters: Type.Object({
            id: Type.String({
                description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
            }),
            message: Type.String({
                description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
            }),
            delivery: Type.Optional(
                StringEnum(['steer', 'follow-up'] as const, {
                    description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.delivery,
                })
            ),
        }),
        async execute(_toolCallId, params, signal) {
            const manager = await getManager()
            const snap = manager.view.get(params.id)
            if (!snap) throw new Error(`Unknown subagent id "${params.id}".`)
            await runTool(
                getRuntime(),
                manager.send(params.id, params.message, params.delivery),
                {
                    signal,
                    interruptMessage: 'Subagent send aborted.',
                }
            )
            return {
                content: [{ type: 'text', text: `Sent to ${params.id}.` }],
                details: {
                    id: params.id,
                    delivery: params.delivery ?? 'follow-up',
                },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_cancel',
        label: 'Cancel Subagents',
        description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
        parameters: Type.Object({
            ids: Type.Array(Type.String(), {
                description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
            }),
        }),
        async execute(_toolCallId, params, signal) {
            const manager = await getManager()
            const ids = [...new Set(params.ids)]
            if (ids.length === 0)
                throw new Error('Provide at least one subagent id.')

            const known = manager.view.list().map((snap) => snap.id)
            const unknown = ids.filter((id) => !manager.view.get(id))
            if (unknown.length > 0) {
                throw new Error(
                    `Unknown subagent id(s): ${unknown.join(', ')}. Known: ${known.join(', ') || 'none'}.`
                )
            }

            const report = await runTool(getRuntime(), manager.interrupt(ids), {
                signal,
                interruptMessage: 'Subagent interrupt aborted.',
            })

            const lines = report.map((entry) =>
                entry.cancelled
                    ? `Cancelled ${entry.id} "${entry.title}".`
                    : `${entry.id} "${entry.title}" was already ${entry.status}.`
            )

            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                details: {
                    results: report.map((entry) => ({
                        id: entry.id,
                        title: entry.title,
                        status: entry.status,
                    })),
                },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_interrupt',
        label: 'Interrupt Subagents',
        description: SUBAGENT_INTERRUPT_TOOL_DESCRIPTION,
        parameters: Type.Object({
            ids: Type.Array(Type.String(), {
                description: SUBAGENT_INTERRUPT_PARAMETER_DESCRIPTIONS.ids,
            }),
        }),
        async execute(_toolCallId, params, signal) {
            const manager = await getManager()
            const ids = [...new Set(params.ids)]
            if (ids.length === 0)
                throw new Error('Provide at least one subagent id.')
            const unknown = ids.filter((id) => !manager.view.get(id))
            if (unknown.length > 0)
                throw new Error(
                    `Unknown subagent id(s): ${unknown.join(', ')}.`
                )
            const report = await runTool(getRuntime(), manager.interrupt(ids), {
                signal,
                interruptMessage: 'Subagent interrupt aborted.',
            })
            return {
                content: [
                    {
                        type: 'text',
                        text: report
                            .map((entry) =>
                                entry.cancelled
                                    ? `Interrupted ${entry.id} "${entry.title}".`
                                    : `${entry.id} "${entry.title}" was already ${entry.status}.`
                            )
                            .join('\n'),
                    },
                ],
                details: { results: report },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_close',
        label: 'Close Subagents',
        description: SUBAGENT_CLOSE_TOOL_DESCRIPTION,
        parameters: Type.Object({
            ids: Type.Array(Type.String(), {
                description: SUBAGENT_CLOSE_PARAMETER_DESCRIPTIONS.ids,
            }),
        }),
        async execute(_toolCallId, params, signal) {
            const manager = await getManager()
            const ids = [...new Set(params.ids)]
            if (ids.length === 0)
                throw new Error('Provide at least one subagent id.')
            const unknown = ids.filter((id) => !manager.view.get(id))
            if (unknown.length > 0)
                throw new Error(
                    `Unknown subagent id(s): ${unknown.join(', ')}.`
                )
            const report = await runTool(getRuntime(), manager.close(ids), {
                signal,
                interruptMessage: 'Subagent close aborted.',
            })
            return {
                content: [
                    {
                        type: 'text',
                        text: report
                            .map((entry) => {
                                if (!entry.terminal)
                                    return `Could not close ${entry.id} "${entry.title}".`
                                if (entry.resourcesReleased)
                                    return `Closed ${entry.id} "${entry.title}".`
                                return `Closed ${entry.id} "${entry.title}"; resource cleanup was incomplete${entry.error ? `: ${entry.error}` : '.'}`
                            })
                            .join('\n'),
                    },
                ],
                details: { results: report },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_check',
        label: 'Check Subagent',
        description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
        parameters: Type.Object({
            id: Type.String({
                description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
            }),
        }),
        async execute(_toolCallId, params) {
            const manager = await getManager()
            const snap = manager.view.get(params.id)
            if (!snap) {
                const known = manager.view.list().map((s) => s.id)
                throw new Error(
                    `Unknown subagent id "${params.id}". Known: ${known.join(', ') || 'none'}.`
                )
            }

            let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`
            if (snap.errorText) text += `\nError: ${snap.errorText}`

            const output = latestText(snap)
            if (output) {
                const preview = truncateHead(output, {
                    maxBytes: CHECK_PREVIEW_MAX_BYTES,
                    maxLines: 20,
                })
                text += `\n\nLatest output:\n${preview.content}`
                if (preview.truncated) text += '\n[...]'
            } else if (snap.status === 'running') {
                text += '\n\n(no text output yet)'
            }

            return {
                content: [{ type: 'text', text }],
                details: {
                    id: snap.id,
                    status: snap.status,
                    turns: snap.turns,
                },
            }
        },
    })

    pi.registerTool({
        name: 'subagent_list',
        label: 'List Subagents',
        description: SUBAGENT_LIST_TOOL_DESCRIPTION,
        parameters: Type.Object({}),
        async execute() {
            const manager = await getManager()
            const subs = manager.view.list()
            const text =
                subs.length === 0
                    ? 'No subagents.'
                    : subs.map((snap) => describeSubagent(snap)).join('\n')
            return {
                content: [{ type: 'text', text }],
                details: {
                    subagents: subs.map((snap) => ({
                        id: snap.id,
                        taskName: snap.taskName,
                        role: snap.role,
                        runtime: 'pi',
                        status: snap.status,
                    })),
                    metrics: manager.getMetrics(),
                },
            }
        },
    })

    // --- Result message rendering ------------------------------------------

    pi.registerMessageRenderer(
        'subagent-result',
        (message, { expanded }, theme) => {
            const details = (message.details ?? {}) as {
                events?: ReadonlyArray<AgentEnvelope>
            }
            const events = details.events ?? []
            const failed = events.some((event) => event.kind === 'error')
            const icon = failed
                ? theme.fg('error', 'x')
                : theme.fg('success', '■')
            const header = `${icon} ${theme.fg('accent', theme.bold('subagent updates'))}`
            const content =
                typeof message.content === 'string' ? message.content : ''
            const body = content.split('\n').slice(1).join('\n').trim()

            if (expanded) {
                const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme())
                const container = new Text(header, 0, 0)
                return {
                    render: (width: number) => [
                        ...container.render(width),
                        ...md.render(width),
                    ],
                    invalidate: () => {
                        container.invalidate()
                        md.invalidate()
                    },
                }
            }

            const previewLines = body.split('\n').slice(0, 8)
            let text = header
            for (const line of previewLines)
                text += `\n${theme.fg('toolOutput', line)}`
            if (body.split('\n').length > 8)
                text += `\n${theme.fg('dim', '... (')}${keyHint('app.tools.expand', 'to expand')}${theme.fg('dim', ')')}`
            return new Text(text, 0, 0)
        }
    )

    // --- Command ------------------------------------------------------------

    pi.registerCommand('subagents', {
        description: 'List, inspect, and take over subagents',
        handler: async (_args, ctx) => {
            if (ctx.mode !== 'tui') {
                if (ctx.hasUI)
                    ctx.ui.notify(
                        'Subagent takeover is only available in the TUI',
                        'error'
                    )
                return
            }
            const manager = await getManager()
            if (manager.view.size() === 0) {
                ctx.ui.notify(
                    'No subagents yet. The agent spawns them with subagent_spawn.',
                    'info'
                )
                return
            }
            await openSubagentPicker(ctx, manager.view, {
                hasPendingQuestion: (id) =>
                    manager
                        .peekMailbox({ agentIds: [id] })
                        .some((envelope) => envelope.kind === 'question'),
            })
        },
    })
}

export default function (pi: ExtensionAPI) {
    createSubagentsExtension(pi)
}
