/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and an explicit built-in child tool allowlist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
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

/** Tools that headless children must not receive. Everything else stays enabled. */
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

/** Return the complete built-in allowlist for a selected child role. */
export function childToolNames(
    role: ReturnType<typeof resolveAgentRole>,
    canReportToParent: boolean
): ReadonlyArray<string> {
    const roleTools = role.readOnly
        ? role.name === 'explorer'
            ? READ_ONLY_TOOL_NAMES
            : REVIEW_TOOL_NAMES
        : CODING_TOOL_NAMES
    return [...roleTools, ...(canReportToParent ? ['report_to_parent'] : [])]
}

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
    NonNullable<Parameters<typeof createAgentSession>[0]>['thinkingLevel']
>

/**
 * Resolve the generic model hint against the child runtime (v1 semantics):
 * "provider/model-id" is exact; a bare id prefers the inherited provider,
 * then must be unambiguous across providers. No hint inherits the parent
 * model; with nothing to inherit, the SDK default applies.
 */
function resolvePiModel(
    modelRuntime: ModelRuntime,
    hint: string | undefined,
    inherited: { provider: string; id: string } | undefined
): Model<any> | undefined {
    if (hint === '@cheapest' || hint === '@capable') {
        const candidates = modelRuntime.getAvailableSnapshot()
        if (candidates.length === 0) {
            return inherited
                ? modelRuntime.getModel(inherited.provider, inherited.id)
                : undefined
        }
        return [...candidates].sort((left, right) => {
            if (hint === '@cheapest') return modelCost(left) - modelCost(right)
            return modelCapability(right) - modelCapability(left)
        })[0]
    }
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
function modelCost(model: Model<any>) {
    return (
        model.cost.input +
        model.cost.output +
        model.cost.cacheRead +
        model.cost.cacheWrite
    )
}

function modelCapability(model: Model<any>) {
    return (
        (model.reasoning ? 1_000_000_000 : 0) +
        model.contextWindow +
        model.maxTokens
    )
}

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
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
    })
    return Promise.race([
        operation.then(
            () => undefined,
            () => undefined
        ),
        timeout,
    ])
        .catch(() => {})
        .finally(() => {
            if (timer) clearTimeout(timer)
        })
}

/** Emit child session_shutdown (bounded), then dispose. Never throws. */
async function shutdownAndDisposeChildSession(session: AgentSession) {
    try {
        if (session.extensionRunner.hasHandlers('session_shutdown')) {
            await waitBounded(
                session.extensionRunner.emit({
                    type: 'session_shutdown',
                    reason: 'quit',
                }),
                CHILD_SHUTDOWN_TIMEOUT_MS
            )
        }
    } catch {
        // Extension runner inspection/emission is best-effort during teardown.
    } finally {
        try {
            session.dispose()
        } catch {
            // Disposal is terminal and must remain idempotent for callers.
        }
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

export interface PiBackendOptions {
    /** Receives bounded questions from the child-only report_to_parent tool. */
    readonly onChildReport?: (report: ChildReport) => void | Promise<void>
    /** Injectable SDK boundary used by integration tests and alternate runtimes. */
    readonly sessionFactory?: PiSessionFactory
}

function createChildReportTool(
    task: SpawnTask,
    onChildReport: NonNullable<PiBackendOptions['onChildReport']>
): ToolDefinition {
    return defineTool({
        name: 'report_to_parent',
        label: 'Report to parent',
        description: 'Ask the parent agent a concise question about this task.',
        parameters: Type.Object({
            kind: Type.Literal('question'),
            message: Type.String({ minLength: 1 }),
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
    sessionFactory: PiSessionFactory = createAgentSession
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
                const childTools = [...childToolNames(role, canReportToParent)]
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
                    // Re-apply the role allowlist after extensions register tools.
                    // Hooks still run in-process; the allowlist limits callable tools,
                    // not arbitrary side effects from trusted extensions.
                    session.setActiveToolsByName(childTools)
                    // Give each queued follow-up its own lifecycle so manager run IDs
                    // remain one-to-one with child runs.
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
            runCounter: 0,
            activeRun: undefined as
                | {
                      id: string
                      startMessageIndex: number
                      settled: boolean
                      error?: string
                  }
                | undefined,
            pendingFollowUpRunIds: [] as string[],
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

        const settle = () => {
            const run = state.activeRun
            if (!run || run.settled) return
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
        }

        const handleEvent = (event: AgentSessionEvent) => {
            if (state.closed) return
            switch (event.type) {
                case 'agent_start':
                    // Extensions may register tools between runs; guard new ones too.
                    toolTimeout.apply(session)
                    if (!state.activeRun || state.activeRun.settled) {
                        const runId = state.pendingFollowUpRunIds.shift()
                        if (runId) beginRun(runId)
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
                    emit({
                        _tag: 'QueueChanged',
                        runId: state.activeRun?.id,
                        queued: [
                            ...event.steering.map((text) => ({
                                text,
                                kind: 'steer' as const,
                            })),
                            ...event.followUp.map((text) => ({
                                text,
                                kind: 'follow-up' as const,
                            })),
                        ],
                    })
                    break
                case 'thinking_level_changed':
                    emit({
                        _tag: 'MetaChanged',
                        meta: currentMeta(),
                        runId: state.activeRun?.id,
                    })
                    break
                case 'agent_settled':
                    settle()
                    break
            }
        }
        const unsubscribe = session.subscribe(handleEvent)

        const closeSession = Effect.promise(async () => {
            if (state.closed) return
            state.closed = true
            unsubscribe()
            try {
                session.clearQueue()
            } catch {
                // Continue with abort/dispose.
            }
            state.pendingFollowUpRunIds = []
            await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS)
            await shutdownAndDisposeChildSession(session)
            Queue.endUnsafe(events)
        })
        yield* Effect.addFinalizer(() => closeSession)

        /** Start a fresh run and convert prompt failures into terminal events. */
        const startRun = (text: string, runId?: string) => {
            beginRun(runId)
            void session.prompt(text).catch((error) => {
                if (state.activeRun && !state.activeRun.settled) {
                    state.activeRun.error = boundedError(error)
                }
                // Preflight failures may never start the agent lifecycle, so no
                // agent_settled will arrive for them.
                if (!session.isStreaming) settle()
            })
        }

        // Session naming is best-effort.
        yield* Effect.try(() =>
            session.sessionManager.appendSessionInfo(`subagent: ${task.title}`)
        ).pipe(Effect.ignore)

        emit({ _tag: 'MetaChanged', meta: currentMeta() })
        startRun(task.prompt, task.runId)

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
                    if (session.isStreaming) {
                        // Queue through the SDK so queue_update and transcript events stay
                        // aligned with the child session's native state.
                        const queuedRunId =
                            delivery === 'follow-up'
                                ? (runId ?? nextRunId())
                                : undefined
                        if (queuedRunId)
                            state.pendingFollowUpRunIds.push(queuedRunId)
                        return Effect.tryPromise({
                            try: () =>
                                delivery === 'follow-up'
                                    ? session.followUp(text)
                                    : session.steer(text),
                            catch: (error) => {
                                if (queuedRunId) {
                                    const index =
                                        state.pendingFollowUpRunIds.lastIndexOf(
                                            queuedRunId
                                        )
                                    if (index >= 0)
                                        state.pendingFollowUpRunIds.splice(
                                            index,
                                            1
                                        )
                                }
                                return new SendError({
                                    message: boundedError(error),
                                })
                            },
                        }).pipe(Effect.asVoid)
                    }
                    return Effect.sync(() => startRun(text, runId))
                }),
            interrupt: Effect.promise(async () => {
                if (state.closed) return
                try {
                    session.clearQueue()
                } catch {
                    // Abort regardless.
                }
                state.pendingFollowUpRunIds = []
                await session.abort().catch(() => undefined)
                // Only resolve once streaming has actually stopped: reporting the
                // interrupt as complete while the run keeps working would let the
                // manager settle a run that is still mutating the workspace. The
                // manager bounds this effect at 5s and force-disposes on timeout.
                while (!state.closed && session.isStreaming) {
                    await new Promise((resolve) => setTimeout(resolve, 50))
                }
                // No streaming run means no agent_settled will arrive; emit the
                // terminal event (once) so the run cannot look running forever.
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
            makePiSession(task, options.onChildReport, options.sessionFactory),
    }
}

export const piBackend = createPiBackend()
