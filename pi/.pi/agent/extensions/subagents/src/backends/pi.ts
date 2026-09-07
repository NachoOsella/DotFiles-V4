/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and an explicit built-in child tool allowlist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run via native steer, or enqueues one
 *   backend-owned follow-up record per logical run; each record is launched
 *   through its own top-level prompt() after the prior SDK run settles;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import * as path from 'node:path'
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import {
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
    type AgentSessionEvent,
    type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { Cause, Scope } from 'effect'
import { Effect, Queue, Stream } from 'effect'
import type {
    BackendCloseResult,
    SendDelivery,
    SubagentBackend,
    SubagentSession,
} from '../backend.ts'
import type {
    SpawnTask,
    SubagentEvent,
    SubagentMeta,
    TranscriptPart,
} from '../domain.ts'
import { SendError, SpawnError } from '../domain.ts'
import {
    CODING_TOOL_NAMES,
    READ_ONLY_TOOL_NAMES,
    REVIEW_TOOL_NAMES,
    isAgentRoleName,
    resolveAgentRole,
    withAgentRoleContextFile,
} from '../roles.ts'

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000
const CHILD_TOOL_CALL_TIMEOUT_MS = 3 * 60 * 1_000

/** Tools that headless children must not receive, even when configured. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
    'subagent_spawn',
    'subagent_wait',
    'subagent_cancel',
    'subagent_interrupt',
    'subagent_close',
    'subagent_send',
    'subagent_check',
    'subagent_list',
    'workflow',
    'ask_user',
] as const

const BUILT_IN_TOOL_NAMES = new Set([
    ...CODING_TOOL_NAMES,
    ...CHILD_EXCLUDED_TOOL_NAMES,
    'report_to_parent',
])

/** Return the role allowlist plus explicitly trusted, registered extensions. */
export function childToolNames(
    role: ReturnType<typeof resolveAgentRole>,
    canReportToParent: boolean,
    allowedExtensionTools: ReadonlyArray<string> = [],
    registeredToolNames: ReadonlyArray<string> = []
): ReadonlyArray<string> {
    const roleTools =
        role.canUseWriteTools === false
            ? role.name === 'explorer'
                ? READ_ONLY_TOOL_NAMES
                : REVIEW_TOOL_NAMES
            : CODING_TOOL_NAMES
    const registered = new Set(registeredToolNames)
    const extensionTools = allowedExtensionTools.filter(
        (name) => !BUILT_IN_TOOL_NAMES.has(name) && registered.has(name)
    )
    return [
        ...new Set([
            ...roleTools,
            ...(canReportToParent ? ['report_to_parent'] : []),
            ...extensionTools,
        ]),
    ]
}

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
    NonNullable<Parameters<typeof createAgentSession>[0]>['thinkingLevel']
>

/**
 * Resolve an explicit model hint against the child runtime. No hint inherits
 * the parent model; with nothing to inherit, the SDK default applies.
 */
export function resolvePiModel(
    modelRuntime: ModelRuntime,
    hint: string | undefined,
    inherited: { provider: string; id: string } | undefined
): Model<any> | undefined {
    if (!hint) {
        if (!inherited) return undefined
        return modelRuntime.getModel(inherited.provider, inherited.id)
    }
    const slash = hint.indexOf('/')
    if (slash > 0) {
        const provider = hint.slice(0, slash)
        const id = hint.slice(slash + 1)
        const found = modelRuntime.getModel(provider, id)
        if (found) return found
        throw new Error(`Unknown model "${hint}".`)
    }
    if (inherited) {
        const found = modelRuntime.getModel(inherited.provider, hint)
        if (found) return found
    }
    const matches = modelRuntime.getModels().filter((m) => m.id === hint)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
        throw new Error(
            `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(', ')}). Use "provider/${hint}".`
        )
    }
    throw new Error(`Unknown model "${hint}".`)
}

/**
 * Parent extensions can register custom providers on their compatibility
 * registry. Copy those registrations into the child runtime, where the SDK
 * now owns model lookup and request authentication.
 */
function copyParentProviderRegistrations(
    parentRegistry:
        NonNullable<SpawnTask['parent']['modelRegistry']> | undefined,
    modelRuntime: ModelRuntime
) {
    if (!parentRegistry) return
    for (const providerId of parentRegistry.getRegisteredProviderIds()) {
        const nativeProvider =
            parentRegistry.getRegisteredNativeProvider(providerId)
        if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider)
        const config = parentRegistry.getRegisteredProviderConfig(providerId)
        if (config) modelRuntime.registerProvider(providerId, config)
    }
}

// --- Child session helpers (ported from v1 shared/child-session.ts) -----------

/** Load normal global/package resources and trust-gated project resources. */
async function createChildResources(
    cwd: string,
    projectTrusted: boolean,
    role: ReturnType<typeof resolveAgentRole>
) {
    const agentDir = getAgentDir()
    const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted,
    })
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        agentsFilesOverride: (current) => ({
            ...current,
            agentsFiles: withAgentRoleContextFile(current.agentsFiles, role),
        }),
    })
    await loader.reload()
    return { loader, settingsManager }
}

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
    })
    return Promise.race([
        operation.then(
            () => true,
            () => false
        ),
        timeout,
    ]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

/** Emit shutdown and dispose without overstating cleanup certainty. */
async function shutdownAndDisposeChildSession(
    session: AgentSession,
    timeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS
): Promise<BackendCloseResult> {
    const errors: string[] = []
    try {
        if (session.extensionRunner.hasHandlers('session_shutdown')) {
            const completed = await waitBounded(
                session.extensionRunner.emit({
                    type: 'session_shutdown',
                    reason: 'quit',
                }),
                timeoutMs
            )
            if (!completed) errors.push('session_shutdown failed or timed out')
        }
    } catch (error) {
        errors.push(`session_shutdown failed: ${boundedError(error)}`)
    }
    try {
        session.dispose()
    } catch (error) {
        errors.push(`session dispose failed: ${boundedError(error)}`)
    }
    return {
        terminal: true,
        resourcesReleased: errors.length === 0,
        ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    }
}

// --- Tool-call timeout guard (ported from v1 shared/tool-call-timeout.ts) -----

/**
 * Wrap every registered child tool with an independent execution timeout so a
 * hung tool cannot wedge a headless child forever. apply() is idempotent and
 * re-applied on agent_start to pick up tools registered between runs.
 */
function createToolCallTimeoutGuard(timeoutMs = CHILD_TOOL_CALL_TIMEOUT_MS) {
    const wrapped = new WeakSet<ToolDefinition>()

    const wrap = (definition: ToolDefinition) => {
        if (wrapped.has(definition)) return
        wrapped.add(definition)
        const execute = definition.execute
        definition.execute = async (
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx
        ) => {
            const timeoutController = new AbortController()
            const executionSignal = signal
                ? AbortSignal.any([signal, timeoutController.signal])
                : timeoutController.signal
            let timer: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(
                        `Tool call "${definition.name}" timed out after ${Math.round(timeoutMs / 60_000)} minutes.`
                    )
                    reject(error)
                    timeoutController.abort(error)
                }, timeoutMs)
            })
            try {
                return await Promise.race([
                    execute.call(
                        definition,
                        toolCallId,
                        params,
                        executionSignal,
                        onUpdate,
                        ctx
                    ),
                    timeout,
                ])
            } finally {
                if (timer) clearTimeout(timer)
            }
        }
    }

    return {
        apply(session: AgentSession) {
            for (const { name } of session.getAllTools()) {
                const definition = session.getToolDefinition(name)
                if (definition) wrap(definition)
            }
        },
    }
}

// --- Event translation ----------------------------------------------------------

function messageRole(msg: unknown): Message['role'] | undefined {
    const role = (msg as { role?: string } | undefined)?.role
    if (role === 'user' || role === 'assistant' || role === 'toolResult')
        return role
    return undefined
}

function lastAssistantMessage(
    session: AgentSession,
    fromMessageIndex = 0
): AssistantMessage | undefined {
    const messages = session.messages
    for (let i = messages.length - 1; i >= fromMessageIndex; i--) {
        const msg = messages[i]
        if (messageRole(msg) === 'assistant') return msg as AssistantMessage
    }
    return undefined
}

/** Final assistant text output produced after the supplied run boundary. */
function finalOutput(session: AgentSession, fromMessageIndex = 0): string {
    const messages = session.messages
    for (let i = messages.length - 1; i >= fromMessageIndex; i--) {
        const msg = messages[i]
        if (messageRole(msg) !== 'assistant') continue
        const text = (msg as AssistantMessage).content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .trim()
        if (text) return text
    }
    return ''
}

function safeJson(value: unknown): string | undefined {
    try {
        const text = JSON.stringify(value)
        return text === '{}' ? undefined : text
    } catch {
        return undefined
    }
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
function toolPreview(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value
            .split('\n')
            .find((line) => line.trim())
            ?.trim()
    }
    if (!value || typeof value !== 'object') return undefined
    const content = (value as { content?: unknown }).content
    if (!Array.isArray(content)) return undefined
    for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const record = part as { type?: unknown; text?: unknown }
        if (record.type !== 'text' || typeof record.text !== 'string') continue
        const firstLine = record.text.split('\n').find((line) => line.trim())
        if (firstLine) return firstLine.trim()
    }
    return undefined
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
    const parts: TranscriptPart[] = []
    for (const part of msg.content) {
        if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text })
        } else if (part.type === 'thinking') {
            parts.push({
                type: 'thinking',
                text: part.redacted ? '' : part.thinking,
                redacted: part.redacted,
            })
        } else if (part.type === 'toolCall') {
            parts.push({
                type: 'toolCall',
                toolId: part.id,
                name: part.name,
                argsPreview: safeJson(part.arguments),
            })
        }
    }
    return parts
}

function userText(msg: Message): string {
    const content = (msg as { content: unknown }).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .filter(
            (part): part is { type: 'text'; text: string } =>
                !!part &&
                typeof part === 'object' &&
                (part as { type?: unknown }).type === 'text'
        )
        .map((part) => part.text)
        .join('\n')
}

// --- The session ------------------------------------------------------------------

function boundedError(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        4096
    )
}

const CHILD_REPORT_MAX_BYTES = 4 * 1024

export interface ChildReport {
    readonly agentId?: string
    readonly taskName?: string
    readonly role?: string
    readonly kind: 'question'
    readonly message: string
}

export type PiSessionFactory = (
    options: Parameters<typeof createAgentSession>[0]
) => ReturnType<typeof createAgentSession>

export const REPORT_TO_PARENT_TOOL_DESCRIPTION =
    'Ask the parent for one specific decision or missing piece of information that is required to continue the assigned task correctly. Use this only for a genuine blocking question that cannot be resolved from the task prompt, repository, tests, or established project conventions. Do not use this tool for progress updates, status reports, discoveries, warnings, suggestions, optional improvements, or non-blocking findings. Keep those for your final response.'

export const REPORT_TO_PARENT_MESSAGE_DESCRIPTION =
    'One concise blocking question for the parent. Include the relevant context, why the decision is needed, and the meaningful alternatives when applicable.'

export interface PiBackendOptions {
    /** Receives bounded questions from the child-only report_to_parent tool. */
    readonly onChildReport?: (report: ChildReport) => void | Promise<void>
    /** Injectable SDK boundary used by integration tests and alternate runtimes. */
    readonly sessionFactory?: PiSessionFactory
    /** Cleanup timeout override for embedders and deterministic tests. */
    readonly cleanupTimeoutMs?: number
}

function createChildReportTool(
    task: SpawnTask,
    onChildReport: NonNullable<PiBackendOptions['onChildReport']>
): ToolDefinition {
    return defineTool({
        name: 'report_to_parent',
        label: 'Report to parent',
        description: REPORT_TO_PARENT_TOOL_DESCRIPTION,
        parameters: Type.Object({
            kind: Type.Literal('question'),
            message: Type.String({
                minLength: 1,
                description: REPORT_TO_PARENT_MESSAGE_DESCRIPTION,
            }),
        }),
        execute: async (_toolCallId, params) => {
            const message = params.message.trim()
            if (!message) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'Question message cannot be empty.',
                        },
                    ],
                    details: {},
                }
            }
            if (Buffer.byteLength(message) > CHILD_REPORT_MAX_BYTES) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Question exceeds the ${CHILD_REPORT_MAX_BYTES}-byte limit.`,
                        },
                    ],
                    details: {},
                }
            }
            task.reportToParent?.(message)
            await onChildReport({
                agentId: task.agentId,
                taskName: task.taskName,
                role: task.role,
                kind: params.kind,
                message,
            })
            return {
                content: [{ type: 'text', text: 'Question sent to parent.' }],
                details: {},
            }
        },
    })
}

const makePiSession = (
    task: SpawnTask,
    onChildReport: PiBackendOptions['onChildReport'],
    sessionFactory: PiSessionFactory = createAgentSession,
    cleanupTimeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
    Effect.gen(function* () {
        const agentDir = getAgentDir()
        const modelRuntime = yield* Effect.tryPromise({
            try: () =>
                ModelRuntime.create({
                    authPath: path.join(agentDir, 'auth.json'),
                    modelsPath: path.join(agentDir, 'models.json'),
                    allowModelNetwork: false,
                }),
            catch: (error) => new SpawnError({ message: boundedError(error) }),
        })
        yield* Effect.try({
            try: () =>
                copyParentProviderRegistrations(
                    task.parent.modelRegistry,
                    modelRuntime
                ),
            catch: (error) => new SpawnError({ message: boundedError(error) }),
        })
        const model = yield* Effect.try({
            try: () =>
                resolvePiModel(
                    modelRuntime,
                    task.model,
                    task.parent.inheritedModel
                ),
            catch: (error) => new SpawnError({ message: boundedError(error) }),
        })
        // pi's thinking levels ARE the shared reasoning-effort scale.
        const thinkingLevel = (task.reasoningEffort ??
            task.parent.inheritedThinkingLevel) as ThinkingLevel | undefined

        const session = yield* Effect.tryPromise({
            try: async () => {
                const role = resolveAgentRole(
                    isAgentRoleName(task.role) ? task.role : undefined
                )
                const { loader, settingsManager } = await createChildResources(
                    task.cwd,
                    task.parent.projectTrusted,
                    role
                )
                const canReportToParent =
                    !!task.reportToParent || !!onChildReport
                // Initial allowedToolNames must include both role base tools and
                // explicitly allowed extension tools, otherwise the AgentSession's
                // allowedToolNames filter (isAllowedTool) would prevent extension
                // tools from ever being registered, even though we later try to
                // activate them via setActiveToolsByName.
                const roleBaseTools = [
                    ...childToolNames(role, canReportToParent),
                ]
                const childTools = [
                    ...new Set([
                        ...roleBaseTools,
                        ...(task.allowedExtensionTools ?? []),
                    ]),
                ]
                const { session } = await sessionFactory({
                    cwd: task.cwd,
                    sessionManager: SessionManager.create(task.cwd, undefined, {
                        parentSession: task.parent.parentSession,
                    }),
                    settingsManager,
                    resourceLoader: loader,
                    modelRuntime,
                    model,
                    thinkingLevel,
                    tools: childTools,
                    customTools: canReportToParent
                        ? [
                              createChildReportTool(task, async (report) => {
                                  if (onChildReport) await onChildReport(report)
                              }),
                          ]
                        : undefined,
                    excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
                })
                // Start child extension session hooks/resources in headless mode.
                // A rejection here would otherwise leak the freshly created session:
                // the scope finalizer that owns cleanup is only registered later.
                try {
                    await session.bindExtensions({ mode: 'print' })
                    // Extensions are trusted code, so only explicitly configured
                    // names that actually registered are added to the role base.
                    const registeredToolNames = session
                        .getAllTools()
                        .map(({ name }) => name)
                    const activeTools = childToolNames(
                        role,
                        canReportToParent,
                        task.allowedExtensionTools,
                        registeredToolNames
                    )

                    // Hooks still run in-process; this allowlist limits callable
                    // tools, not arbitrary side effects from trusted extensions.
                    session.setActiveToolsByName([...activeTools])
                    // Native follow-up queues are unused by this backend (each
                    // logical run gets its own top-level prompt), but keep the
                    // SDK in single-drain mode for predictable steering behavior.
                    session.setFollowUpMode('one-at-a-time')
                } catch (error) {
                    await shutdownAndDisposeChildSession(session)
                    throw error
                }
                return session
            },
            catch: (error) => new SpawnError({ message: boundedError(error) }),
        })

        const state = {
            closed: false,
            // Backend-owned dispatch lifecycle. Never rely solely on
            // `session.isStreaming`: prompt preflight runs while it is false.
            // Only `idle` may start a new top-level `session.prompt`.
            lifecycle: 'idle' as 'idle' | 'starting' | 'running',
            // The SDK reports `isStreaming === false` during prompt preflight.
            // Retain the operation so interrupt/close cannot acknowledge cleanup
            // before that preflight either settles or times out.
            promptOperation: undefined as Promise<void> | undefined,
            // Invalidates in-flight prompt handlers after interrupt/close so a
            // late preflight rejection can never settle a newer run.
            epoch: 0,
            runCounter: Number(task.runId?.match(/:run-(\d+)$/)?.[1] ?? 0),
            activeRun: undefined as
                | {
                      id: string
                      startMessageIndex: number
                      settled: boolean
                      error?: string
                  }
                | undefined,
            // Backend-owned FIFO of follow-up assignments. Native
            // `session.followUp` is never used for logical runs: the SDK drains
            // native follow-ups inside the same agent loop without a fresh
            // `agent_start`/`agent_settled` pair, which stranded manager runs.
            // Each record is launched via its own top-level `session.prompt`
            // after the prior SDK run fully settles.
            queue: [] as Array<{ runId: string; text: string }>,
            nativeSteering: [] as string[],
        }

        const events = yield* Queue.make<SubagentEvent, Cause.Done>()
        const emit = (event: SubagentEvent) => {
            Queue.offerUnsafe(events, event)
        }

        const toolTimeout = createToolCallTimeoutGuard()
        toolTimeout.apply(session)

        const activeModel = (): Model<any> | undefined => {
            const sessionModel = session.model
            const last = lastAssistantMessage(session)
            if (!last) return sessionModel
            if (
                sessionModel &&
                (last.provider !== sessionModel.provider ||
                    last.model !== sessionModel.id)
            ) {
                // The session changed models after this assistant response.
                return sessionModel
            }
            return (
                modelRuntime.getModel(
                    last.provider,
                    last.responseModel ?? last.model
                ) ?? sessionModel
            )
        }

        const currentMeta = (): SubagentMeta => {
            const m = activeModel()
            return {
                backend: 'pi',
                modelLabel: m ? `${m.provider}/${m.id}` : undefined,
                thinkingLevel: session.thinkingLevel,
                contextWindow: m?.contextWindow,
                sessionFilePath: session.sessionFile,
            }
        }

        const emitUsage = () => {
            const usage = session.getContextUsage()
            emit({
                _tag: 'UsageChanged',
                tokens: usage?.tokens ?? undefined,
                contextWindow:
                    activeModel()?.contextWindow ?? usage?.contextWindow,
                runId: state.activeRun?.id,
            })
        }

        const nextRunId = () =>
            `${task.agentId ?? 'subagent'}:run-${++state.runCounter}`

        const beginRun = (runId = nextRunId()) => {
            state.activeRun = {
                id: runId,
                startMessageIndex: session.messages.length,
                settled: false,
            }
            emit({ _tag: 'RunStarted', runId })
            return runId
        }

        const emitQueue = () => {
            if (state.closed) return
            emit({
                _tag: 'QueueChanged',
                runId: state.activeRun?.id,
                queued: [
                    ...state.nativeSteering.map((text) => ({
                        text,
                        kind: 'steer' as const,
                    })),
                    ...state.queue.map(({ text, runId }) => ({
                        text,
                        kind: 'follow-up' as const,
                        runId,
                    })),
                ],
            })
        }

        /**
         * Launch the next queued assignment only when the prior SDK run has
         * settled (lifecycle idle) AND its top-level prompt promise has
         * resolved. `agent_settled` can arrive while that promise is still
         * pending; dispatching early would overlap prompts. The pending
         * prompt handler drains the queue once it clears `promptOperation`.
         */
        const pumpNext = () => {
            if (state.closed) return
            if (state.lifecycle !== 'idle') return
            if (state.promptOperation) return
            const next = state.queue.shift()
            if (!next) return
            dispatch(next)
        }

        /**
         * Reserve `starting` synchronously, then launch one top-level
         * `session.prompt`. All later follow-ups enqueue until this prompt
         * settles. Prompt handlers are correlated to the captured run so a
         * rejection from A can never settle B.
         */
        const dispatch = (record: { runId: string; text: string }) => {
            if (state.closed) return
            if (state.lifecycle !== 'idle' || state.promptOperation) {
                state.queue.unshift(record)
                return
            }
            state.lifecycle = 'starting'
            const epochAtDispatch = state.epoch
            beginRun(record.runId)
            emitQueue()
            const captured = state.activeRun
            if (!captured) {
                state.lifecycle = 'idle'
                return
            }
            const promptOperation = Promise.resolve().then(() =>
                session.prompt(record.text)
            )
            state.promptOperation = promptOperation
            void promptOperation.then(
                () => {
                    if (state.promptOperation === promptOperation)
                        state.promptOperation = undefined
                    if (state.closed || epochAtDispatch !== state.epoch) {
                        if (state.lifecycle === 'idle') pumpNext()
                        return
                    }
                    if (state.activeRun !== captured || captured.settled) {
                        if (state.lifecycle === 'idle') pumpNext()
                        return
                    }
                    // Success without any agent lifecycle (for example an
                    // extension command): no `agent_settled` will arrive.
                    settleRun(captured)
                },
                (error) => {
                    if (state.promptOperation === promptOperation)
                        state.promptOperation = undefined
                    if (state.closed || epochAtDispatch !== state.epoch) {
                        if (state.lifecycle === 'idle') pumpNext()
                        return
                    }
                    if (
                        state.activeRun !== captured ||
                        captured.settled
                    ) {
                        if (state.lifecycle === 'idle') pumpNext()
                        return
                    }
                    // Preflight failures never start the agent lifecycle, so no
                    // `agent_settled` will arrive for them.
                    captured.error = boundedError(error)
                    settleRun(captured)
                }
            )
        }

        const settleRun = (
            captured:
                | NonNullable<typeof state.activeRun>
                | undefined
        ) => {
            const run = captured ?? state.activeRun
            if (!run || run.settled) return
            // A late callback from a previous dispatch must never settle the
            // newer active run.
            if (state.activeRun !== run) return
            run.settled = true
            const last = lastAssistantMessage(session, run.startMessageIndex)
            const partialText =
                finalOutput(session, run.startMessageIndex) || undefined
            if (last?.stopReason === 'aborted') {
                emit({
                    _tag: 'RunSettled',
                    runId: run.id,
                    outcome: { _tag: 'Interrupted', partialText },
                })
                state.lifecycle = 'idle'
                emitQueue()
                pumpNext()
                return
            }
            const errorText =
                run.error ??
                (last?.stopReason === 'error'
                    ? (last.errorMessage ?? 'Run failed')
                    : undefined)
            if (errorText !== undefined) {
                emit({
                    _tag: 'RunSettled',
                    runId: run.id,
                    outcome: {
                        _tag: 'Failed',
                        errorText: boundedError(errorText),
                        partialText,
                    },
                })
                state.lifecycle = 'idle'
                emitQueue()
                pumpNext()
                return
            }
            emit({
                _tag: 'RunSettled',
                runId: run.id,
                outcome: {
                    _tag: 'Completed',
                    finalText: finalOutput(session, run.startMessageIndex),
                },
            })
            state.lifecycle = 'idle'
            emitQueue()
            pumpNext()
        }

        const handleEvent = (event: AgentSessionEvent) => {
            if (state.closed) return
            switch (event.type) {
                case 'agent_start':
                    // Extensions may register tools between runs; guard new ones too.
                    toolTimeout.apply(session)
                    // Logical runs are allocated at dispatch time, not here. A
                    // single top-level prompt can emit extra starts for native
                    // retry/compaction continuations; they share the active run.
                    if (
                        state.activeRun &&
                        !state.activeRun.settled &&
                        state.lifecycle === 'starting'
                    ) {
                        state.lifecycle = 'running'
                    }
                    break
                case 'message_update': {
                    const streamEvent = event.assistantMessageEvent
                    if (streamEvent.type === 'text_delta') {
                        emit({
                            _tag: 'AssistantDelta',
                            kind: 'text',
                            delta: streamEvent.delta,
                            runId: state.activeRun?.id,
                        })
                    } else if (streamEvent.type === 'thinking_delta') {
                        emit({
                            _tag: 'AssistantDelta',
                            kind: 'thinking',
                            delta: streamEvent.delta,
                            runId: state.activeRun?.id,
                        })
                    }
                    break
                }
                case 'message_end': {
                    const role = messageRole(event.message)
                    if (role === 'user') {
                        const text = userText(event.message as Message)
                        if (text.trim())
                            emit({
                                _tag: 'UserMessage',
                                text,
                                runId: state.activeRun?.id,
                            })
                    } else if (role === 'assistant') {
                        emit({
                            _tag: 'AssistantMessage',
                            parts: assistantParts(
                                event.message as AssistantMessage
                            ),
                            runId: state.activeRun?.id,
                        })
                        emitUsage()
                        emit({
                            _tag: 'MetaChanged',
                            meta: currentMeta(),
                            runId: state.activeRun?.id,
                        })
                    }
                    // toolResult messages are covered by tool_execution_end.
                    break
                }
                case 'tool_execution_start':
                    emit({
                        _tag: 'ToolStart',
                        toolId: event.toolCallId,
                        name: event.toolName,
                        argsPreview: safeJson(event.args),
                        runId: state.activeRun?.id,
                    })
                    break
                case 'tool_execution_update':
                    emit({
                        _tag: 'ToolUpdate',
                        toolId: event.toolCallId,
                        outputPreview: toolPreview(event.partialResult),
                        runId: state.activeRun?.id,
                    })
                    break
                case 'tool_execution_end':
                    emit({
                        _tag: 'ToolEnd',
                        toolId: event.toolCallId,
                        name: event.toolName,
                        isError: event.isError,
                        outputPreview: toolPreview(event.result),
                        runId: state.activeRun?.id,
                    })
                    break
                case 'queue_update':
                    // Merge native steering with the backend-owned follow-up
                    // FIFO. Native follow-ups are never used for logical runs;
                    // the takeover UI reads the merged view.
                    state.nativeSteering = [...event.steering]
                    emitQueue()
                    break
                case 'thinking_level_changed':
                    emit({
                        _tag: 'MetaChanged',
                        meta: currentMeta(),
                        runId: state.activeRun?.id,
                    })
                    break
                case 'agent_settled':
                    if (state.activeRun && !state.activeRun.settled) {
                        settleRun(state.activeRun)
                    } else if (state.lifecycle === 'idle') {
                        // Stale settlement from an orphaned SDK run: the logical
                        // run was already resolved, but the SDK just became idle.
                        // Drain anything queued while it was busy.
                        pumpNext()
                    }
                    break
            }
        }
        const unsubscribe = session.subscribe(handleEvent)

        let closePromise: Promise<BackendCloseResult> | undefined
        const closeSession = Effect.promise(() => {
            if (closePromise) return closePromise
            closePromise = (async () => {
                const errors: string[] = []
                state.closed = true
                state.epoch++
                unsubscribe()
                try {
                    session.clearQueue()
                } catch (error) {
                    errors.push(`clear queue failed: ${boundedError(error)}`)
                }
                state.queue = []
                state.nativeSteering = []
                const aborted = await waitBounded(
                    Promise.resolve().then(() => session.abort()),
                    cleanupTimeoutMs
                )
                if (!aborted) errors.push('session abort failed or timed out')
                const promptOperation = state.promptOperation
                if (promptOperation) {
                    const completed = await waitBounded(
                        promptOperation,
                        cleanupTimeoutMs
                    )
                    if (!completed)
                        errors.push('active prompt failed or timed out')
                    // A preflight can finish and start the SDK run after the
                    // first abort call. Abort once more before disposal so a
                    // prompt that did settle is not left running.
                    if (completed) {
                        const abortedAfterPrompt = await waitBounded(
                            Promise.resolve().then(() => session.abort()),
                            cleanupTimeoutMs
                        )
                        if (!abortedAfterPrompt)
                            errors.push(
                                'session abort after prompt failed or timed out'
                            )
                    }
                }
                const disposed = await shutdownAndDisposeChildSession(
                    session,
                    cleanupTimeoutMs
                )
                if (!disposed.resourcesReleased && disposed.error)
                    errors.push(disposed.error)
                Queue.endUnsafe(events)
                return {
                    terminal: true,
                    resourcesReleased: errors.length === 0,
                    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
                }
            })()
            return closePromise
        })
        yield* Effect.addFinalizer(() => closeSession)

        // Session naming is best-effort.
        yield* Effect.try(() =>
            session.sessionManager.appendSessionInfo(`subagent: ${task.title}`)
        ).pipe(Effect.ignore)

        emit({ _tag: 'MetaChanged', meta: currentMeta() })
        dispatch({ runId: task.runId ?? nextRunId(), text: task.prompt })

        return {
            meta: Effect.sync(currentMeta),
            events: Stream.fromQueue(events),
            send: (
                text,
                delivery: SendDelivery = 'follow-up',
                runId?: string
            ) =>
                Effect.suspend((): Effect.Effect<void, SendError> => {
                    if (state.closed) {
                        return new SendError({
                            message: 'Subagent session is closed.',
                        })
                    }
                    if (
                        delivery === 'steer' &&
                        state.lifecycle !== 'idle'
                    ) {
                        // Redirect the active run without allocating a new
                        // logical assignment.
                        return Effect.tryPromise({
                            try: () => session.steer(text),
                            catch: (error) =>
                                new SendError({
                                    message: boundedError(error),
                                }),
                        }).pipe(Effect.asVoid)
                    }
                    // One logical follow-up assignment per manager run ID.
                    // The reservation below is synchronous so two concurrent
                    // sends cannot both observe `idle` during prompt preflight.
                    // Queue while the prior prompt promise is still pending,
                    // even when settlement already flipped lifecycle to idle.
                    const record = {
                        runId: runId ?? nextRunId(),
                        text,
                    }
                    if (state.lifecycle !== 'idle' || state.promptOperation) {
                        state.queue.push(record)
                        emitQueue()
                        return Effect.void
                    }
                    return Effect.sync(() => {
                        dispatch(record)
                    })
                }),
            interrupt: Effect.promise(async () => {
                if (state.closed) return
                state.epoch++
                state.queue = []
                state.nativeSteering = []
                try {
                    session.clearQueue()
                } catch {
                    // Abort regardless.
                }
                emitQueue()
                await session.abort().catch(() => undefined)
                // `session.abort()` cannot see SDK prompt preflight because the
                // session still reports idle. Wait for the outstanding prompt
                // operation before acknowledging interrupt; the manager bounds
                // this effect and force-disposes on timeout if it never settles.
                const promptOperation = state.promptOperation
                if (promptOperation) await promptOperation.catch(() => undefined)
                // Only resolve once streaming has actually stopped: reporting the
                // interrupt as complete while the run keeps working would let the
                // manager settle a run that is still mutating the workspace. The
                // manager bounds this effect at 5s and force-disposes on timeout.
                while (!state.closed && session.isStreaming) {
                    await new Promise((resolve) => setTimeout(resolve, 50))
                }
                // No streaming run means no agent_settled will arrive; emit the
                // terminal event (once) so the run cannot look running forever.
                // Late prompt handlers are epoch-invalidated and cannot settle
                // a newer run. If a stale preflight later starts an orphaned
                // SDK run, its stale settlement still pumps queued work.
                if (
                    !state.closed &&
                    state.activeRun &&
                    !state.activeRun.settled
                ) {
                    state.activeRun.settled = true
                    emit({
                        _tag: 'RunSettled',
                        runId: state.activeRun.id,
                        outcome: { _tag: 'Interrupted' },
                    })
                    state.lifecycle = 'idle'
                    emitQueue()
                }
            }),
            close: closeSession,
        } satisfies SubagentSession
    })

export function createPiBackend(
    options: PiBackendOptions = {}
): SubagentBackend {
    return {
        name: 'pi',
        capabilities: {
            steering: true,
            modelSelection: true,
            reasoningEffort: true,
        },
        // In-process SDK: always available.
        available: Effect.succeed(true),
        spawn: (task) =>
            makePiSession(
                task,
                options.onChildReport,
                options.sessionFactory,
                options.cleanupTimeoutMs
            ),
    }
}

export const piBackend = createPiBackend()
