/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
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
    'subagent_send',
    'subagent_check',
    'subagent_list',
    'workflow',
    'ask_user',
] as const

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
    session: AgentSession
): AssistantMessage | undefined {
    const messages = session.messages
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (messageRole(msg) === 'assistant') return msg as AssistantMessage
    }
    return undefined
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
function finalOutput(session: AgentSession): string {
    const messages = session.messages
    for (let i = messages.length - 1; i >= 0; i--) {
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

export interface PiBackendOptions {
    /** Receives bounded questions from the child-only report_to_parent tool. */
    readonly onChildReport?: (report: ChildReport) => void | Promise<void>
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
    onChildReport: PiBackendOptions['onChildReport']
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
                const childTools = role.readOnly
                    ? [
                          'read',
                          'grep',
                          'find',
                          'ls',
                          'lsp',
                          ...(canReportToParent ? ['report_to_parent'] : []),
                      ]
                    : undefined
                const { session } = await createAgentSession({
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
            /** prompt() rejection for the active run; folded into RunSettled. */
            runError: undefined as string | undefined,
            /** One terminal event per run: lifecycle, prompt-rejection, and abort
             * fallbacks can all race to settle; the first wins. */
            settled: false,
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
            })
        }

        const settle = () => {
            if (state.settled) return
            state.settled = true
            const last = lastAssistantMessage(session)
            const partialText = finalOutput(session) || undefined
            if (last?.stopReason === 'aborted') {
                emit({
                    _tag: 'RunSettled',
                    outcome: { _tag: 'Interrupted', partialText },
                })
                return
            }
            const errorText =
                state.runError ??
                (last?.stopReason === 'error'
                    ? (last.errorMessage ?? 'Run failed')
                    : undefined)
            if (errorText !== undefined) {
                emit({
                    _tag: 'RunSettled',
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
                outcome: { _tag: 'Completed', finalText: finalOutput(session) },
            })
        }

        const handleEvent = (event: AgentSessionEvent) => {
            if (state.closed) return
            switch (event.type) {
                case 'agent_start':
                    // Extensions may register tools between runs; guard new ones too.
                    toolTimeout.apply(session)
                    state.settled = false
                    emit({ _tag: 'RunStarted' })
                    break
                case 'message_update': {
                    const streamEvent = event.assistantMessageEvent
                    if (streamEvent.type === 'text_delta') {
                        emit({
                            _tag: 'AssistantDelta',
                            kind: 'text',
                            delta: streamEvent.delta,
                        })
                    } else if (streamEvent.type === 'thinking_delta') {
                        emit({
                            _tag: 'AssistantDelta',
                            kind: 'thinking',
                            delta: streamEvent.delta,
                        })
                    }
                    break
                }
                case 'message_end': {
                    const role = messageRole(event.message)
                    if (role === 'user') {
                        const text = userText(event.message as Message)
                        if (text.trim()) emit({ _tag: 'UserMessage', text })
                    } else if (role === 'assistant') {
                        emit({
                            _tag: 'AssistantMessage',
                            parts: assistantParts(
                                event.message as AssistantMessage
                            ),
                        })
                        emitUsage()
                        emit({ _tag: 'MetaChanged', meta: currentMeta() })
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
                    })
                    break
                case 'tool_execution_update':
                    emit({
                        _tag: 'ToolUpdate',
                        toolId: event.toolCallId,
                        outputPreview: toolPreview(event.partialResult),
                    })
                    break
                case 'tool_execution_end':
                    emit({
                        _tag: 'ToolEnd',
                        toolId: event.toolCallId,
                        name: event.toolName,
                        isError: event.isError,
                        outputPreview: toolPreview(event.result),
                    })
                    break
                case 'queue_update':
                    emit({
                        _tag: 'QueueChanged',
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
                    emit({ _tag: 'MetaChanged', meta: currentMeta() })
                    break
                case 'agent_settled':
                    settle()
                    break
            }
        }
        const unsubscribe = session.subscribe(handleEvent)

        yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
                state.closed = true
                unsubscribe()
                try {
                    session.clearQueue()
                } catch {
                    // Continue with abort/dispose.
                }
                await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS)
                await shutdownAndDisposeChildSession(session)
                Queue.endUnsafe(events)
            })
        )

        /** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
        const startRun = (text: string) => {
            state.runError = undefined
            state.settled = false
            emit({ _tag: 'RunStarted' })
            void session.prompt(text).catch((error) => {
                state.runError = boundedError(error)
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
        startRun(task.prompt)

        return {
            meta: Effect.sync(currentMeta),
            events: Stream.fromQueue(events),
            send: (text, delivery: SendDelivery = 'steer') =>
                Effect.suspend((): Effect.Effect<void, SendError> => {
                    if (state.closed) {
                        return new SendError({
                            message: 'Subagent session is closed.',
                        })
                    }
                    if (session.isStreaming) {
                        // Queue through the SDK so queue_update and transcript events stay
                        // aligned with the child session's native state.
                        return Effect.tryPromise({
                            try: () =>
                                delivery === 'follow-up'
                                    ? session.followUp(text)
                                    : session.steer(text),
                            catch: (error) =>
                                new SendError({ message: boundedError(error) }),
                        }).pipe(Effect.asVoid)
                    }
                    return Effect.sync(() => startRun(text))
                }),
            interrupt: Effect.promise(async () => {
                if (state.closed) return
                try {
                    session.clearQueue()
                } catch {
                    // Abort regardless.
                }
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
                if (!state.closed && !state.settled) {
                    state.settled = true
                    emit({
                        _tag: 'RunSettled',
                        outcome: { _tag: 'Interrupted' },
                    })
                }
            }),
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
        spawn: (task) => makePiSession(task, options.onChildReport),
    }
}

export const piBackend = createPiBackend()
