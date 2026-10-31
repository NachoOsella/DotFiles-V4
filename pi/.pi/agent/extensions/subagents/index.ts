import {
    VERSION,
    type ExtensionAPI,
    type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { showAgentsModal } from './src/ui/agents-modal.ts'
import type { CodexSubagentsConfig } from './src/config/config.ts'
import { loadSubagentsConfig } from './src/config/entry-config.ts'
import { assertSupportedHost } from './src/config/host-compatibility.ts'
import { SubagentCoordinator } from './src/core/coordinator.ts'
import {
    buildRootToolDefinitions,
    buildChildToolDefinitions,
} from './src/tools/extension-tools.ts'
import {
    rootEndpoint,
    SUBAGENTS_COMMUNICATION_CUSTOM_TYPE,
} from './src/core/transport.ts'
import { renderSubagentCommunication } from './src/ui/final-answer-renderer.ts'
import { resolveConfiguredMode } from './src/config/mode.ts'
import { plannedToolNames } from './src/tools/tool-specs.ts'
import {
    findLatestState,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from './src/persistence/session-state.ts'
import { assembleRootPrompt } from './src/config/prompts.ts'
import {
    SUBAGENTS_INFO_CHANNEL,
    REFRESH_CHANNEL,
} from '../shared/dashboard-state.ts'
import type { AgentPath } from './src/domain/ids.ts'
import type { ParentExecutionSnapshot } from './src/domain/parent-snapshot.ts'

export { loadSubagentsConfig } from './src/config/entry-config.ts'

const ROOT_PATH = '/root' as AgentPath

function reportDiagnostic(
    ctx: ExtensionContext,
    operation: string,
    error: unknown
): void {
    const reason = error instanceof Error ? error.message : String(error)
    const message = `${operation}: ${reason}`
    try {
        if (ctx.hasUI) {
            ctx.ui.notify(message, 'error')
            return
        }
    } catch {
        // A failed asynchronous operation may outlive its extension context.
    }
    console.error(`[subagents] ${message}`)
}

export default function subagentsExtension(pi: ExtensionAPI) {
    let config: CodexSubagentsConfig
    try {
        config = loadSubagentsConfig()
        if (config.enabled) assertSupportedHost(VERSION)
    } catch (error) {
        pi.on('session_start', (_event, ctx) => {
            reportDiagnostic(ctx, 'Subagents disabled', error)
        })
        return
    }
    if (!config.enabled) return

    pi.registerMessageRenderer(
        SUBAGENTS_COMMUNICATION_CUSTOM_TYPE,
        renderSubagentCommunication
    )

    let coordinator: SubagentCoordinator | undefined
    let latestCtx: ExtensionContext | undefined
    let generation = 0
    let retiring = false
    let retirement: Promise<void> | undefined
    let receiptTimer: ReturnType<typeof setTimeout> | undefined
    const initialized = new WeakSet<SubagentCoordinator>()
    const checkpoints = new WeakMap<SubagentCoordinator, string>()

    const publishSubagentInfo = (manager: SubagentCoordinator): void => {
        const running = manager
            .list(ROOT_PATH)
            .filter((agent) => agent.status === 'Running').length
        const ctx = latestCtx
        if (!ctx) return
        const snapshot = manager.serialize(ctx.sessionManager.getSessionId())
        const { cost, ...promptTokens } = manager.usageTotals()
        pi.events.emit(SUBAGENTS_INFO_CHANNEL, {
            running,
            cost,
            promptTokens,
            snapshot,
        })
    }

    const rootSnapshot = (): ParentExecutionSnapshot => {
        const ctx = latestCtx
        const model = ctx?.model
        if (!ctx || !model) throw new Error('Root Pi session is not ready.')
        return {
            path: ROOT_PATH,
            cwd: ctx.cwd,
            model: { provider: model.provider, id: model.id },
            thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
            activeTools: pi.getActiveTools(),
            contextEntries: ctx.sessionManager.getBranch(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionId: ctx.sessionManager.getSessionId(),
        }
    }

    const getCoordinator = (): SubagentCoordinator => {
        if (retiring) {
            throw new Error(
                'The subagent team is closing. If checkpoint persistence failed, resolve the error and retry navigation or reload.'
            )
        }
        if (!coordinator) {
            const currentGeneration = generation
            const manager: SubagentCoordinator = new SubagentCoordinator({
                config,
                getRootSnapshot: rootSnapshot,
                deliveryReceipts: true,
                onLoaderDiagnostics: (diagnostics) => {
                    if (
                        latestCtx &&
                        generation === currentGeneration &&
                        !retiring
                    ) {
                        reportDiagnostic(
                            latestCtx,
                            'Child resource loading',
                            diagnostics.join('\n')
                        )
                    }
                },
                rootEndpoint: rootEndpoint(
                    ROOT_PATH,
                    (message, options) => {
                        if (
                            generation !== currentGeneration ||
                            coordinator !== manager ||
                            retiring
                        ) {
                            throw new Error('The recipient branch is detached.')
                        }
                        pi.sendMessage(message, options)
                    },
                    (communicationId) => {
                        if (
                            generation !== currentGeneration ||
                            coordinator !== manager ||
                            !latestCtx
                        ) {
                            return 'unknown'
                        }
                        return latestCtx.sessionManager
                            .getBranch()
                            .some(
                                (entry) =>
                                    entry.type === 'custom_message' &&
                                    entry.customType ===
                                        SUBAGENTS_COMMUNICATION_CUSTOM_TYPE &&
                                    typeof entry.details === 'object' &&
                                    entry.details !== null &&
                                    (entry.details as { id?: unknown }).id ===
                                        communicationId
                            )
                            ? 'accepted'
                            : 'absent'
                    }
                ),
                rootSessionId: () =>
                    latestCtx?.sessionManager.getSessionId() ?? 'unknown-root',
                isRootStreaming: () => {
                    const ctx = latestCtx
                    return ctx ? !ctx.isIdle() : false
                },
                rootSessionDir: () =>
                    latestCtx?.sessionManager.getSessionDir() ?? '',
                getModelRegistry: () => {
                    if (!latestCtx)
                        throw new Error('Root Pi session is not ready.')
                    return latestCtx.modelRegistry
                },
                buildTools: (caller) =>
                    buildChildToolDefinitions(manager, caller),
            })
            coordinator = manager
            manager.onDeliveryCheckpoint(() => {
                if (
                    generation !== currentGeneration ||
                    coordinator !== manager ||
                    !latestCtx
                ) {
                    throw new Error('The checkpoint branch is detached.')
                }
                persistCheckpoint(manager, latestCtx)
            })
            manager.onEvent((event) => {
                if (
                    generation !== currentGeneration ||
                    coordinator !== manager
                ) {
                    return
                }
                if (
                    event._tag === 'StatusChanged' ||
                    event._tag === 'UsageUpdated'
                ) {
                    publishSubagentInfo(manager)
                }
                if (
                    event._tag === 'StatusChanged' ||
                    event._tag === 'ResidencyChanged' ||
                    event._tag === 'ActivityCompleted' ||
                    event._tag === 'ActivityInterrupted'
                ) {
                    persistSafely()
                }
            })
        }
        if (latestCtx && !initialized.has(coordinator)) {
            initialized.add(coordinator)
            coordinator.bindSession(
                latestCtx.sessionManager.getSessionId(),
                ROOT_PATH
            )
            const persisted = findLatestState(
                latestCtx.sessionManager.getBranch()
            )
            if (persisted) coordinator.restore(persisted)
        }
        return coordinator
    }

    const toolNames = plannedToolNames(config.waitAgentEnabled)
    for (const tool of buildRootToolDefinitions(getCoordinator)) {
        if (toolNames.includes(tool.name)) pi.registerTool(tool as never)
    }

    pi.registerCommand('agents', {
        description: 'Inspect subagents',
        handler: async (_args, ctx) => {
            await showAgentsModal(getCoordinator(), ctx)
        },
    })

    pi.registerShortcut('alt+a', {
        description: 'Inspect subagents',
        handler: async (ctx) => {
            await showAgentsModal(getCoordinator(), ctx)
        },
    })

    const stopRefresh = pi.events.on(REFRESH_CHANNEL, () => {
        if (coordinator && latestCtx) publishSubagentInfo(coordinator)
    })

    pi.on('session_start', async (_event, ctx) => {
        latestCtx = ctx
        const manager = getCoordinator()
        publishSubagentInfo(manager)
        await observeReceipts(ctx)
        scheduleReceiptCheck(ctx)
    })

    pi.on('session_before_tree', async (event, ctx) => {
        if (event.signal.aborted) return { cancel: true }
        latestCtx = ctx
        try {
            await retireCoordinator(ctx)
            if (event.signal.aborted) {
                getCoordinator()
                return { cancel: true }
            }
        } catch (error) {
            reportDiagnostic(ctx, 'Cannot detach subagent team', error)
            return { cancel: true }
        }
    })

    pi.on('session_tree', async (_event, ctx) => {
        // Hosts emitting only the post-navigation event must not checkpoint
        // the abandoned team's graph into the already-selected branch.
        await retireCoordinator(ctx, false)
        latestCtx = ctx
        publishSubagentInfo(getCoordinator())
        await observeReceipts(ctx)
        scheduleReceiptCheck(ctx)
    })

    pi.on('input', (_event, ctx) => {
        latestCtx = ctx
        // Only mid-run input interrupts waits. A fresh prompt from idle would
        // otherwise leave a stale steer signal that instantly aborts the
        // run's first wait_agent with "interrupted by new input".
        if (ctx.isIdle()) return
        getCoordinator().notifySteer(
            getCoordinator().callerFromSession(
                ctx.sessionManager.getSessionId()
            )
        )
    })

    pi.on('agent_settled', async (_event, ctx) => {
        latestCtx = ctx
        await observeReceipts(ctx)
        persistSafely()
        scheduleReceiptCheck(ctx)
    })

    pi.on('tool_result', async (_event, ctx) => {
        latestCtx = ctx
        await observeReceipts(ctx)
        scheduleReceiptCheck(ctx)
    })

    pi.on('message_end', async (_event, ctx) => {
        latestCtx = ctx
        await observeReceipts(ctx)
        scheduleReceiptCheck(ctx)
    })

    pi.on('context', async (_event, ctx) => {
        latestCtx = ctx
        await observeReceipts(ctx)
    })

    pi.on('before_agent_start', (event, ctx) => {
        latestCtx = ctx
        const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel()
        const fragment = assembleRootPrompt({
            config,
            mode: resolveConfiguredMode(config, thinking),
            activeSlotCount: config.maxConcurrentExecutions,
        })
        event.systemPromptOptions.sections.subagents = fragment
    })

    pi.on('session_shutdown', async (_event, ctx) => {
        stopRefresh()
        try {
            await retireCoordinator(ctx)
        } catch (error) {
            reportDiagnostic(ctx, 'Cannot persist closed subagent team', error)
        } finally {
            latestCtx = undefined
            pi.events.emit(SUBAGENTS_INFO_CHANNEL, { running: 0 })
        }
    })

    function persistCheckpoint(
        manager: SubagentCoordinator,
        ctx: ExtensionContext
    ): void {
        const snapshot = manager.serialize(ctx.sessionManager.getSessionId())
        const { persistedAt: _persistedAt, ...state } = snapshot
        const fingerprint = JSON.stringify(state)
        if (checkpoints.get(manager) === fingerprint) return
        pi.appendEntry(SUBAGENTS_STATE_CUSTOM_TYPE, snapshot)
        checkpoints.set(manager, fingerprint)
    }

    function persistSafely(): void {
        const ctx = latestCtx
        const manager = coordinator
        if (!ctx || !manager || retiring) return
        try {
            persistCheckpoint(manager, ctx)
        } catch (error) {
            reportDiagnostic(ctx, 'Cannot checkpoint subagent team', error)
        }
    }

    async function observeReceipts(ctx: ExtensionContext): Promise<void> {
        const manager = coordinator
        if (!manager || retiring) return
        try {
            await manager.reconcileDeliveryReceipts(ROOT_PATH)
        } catch (error) {
            reportDiagnostic(ctx, 'Cannot reconcile subagent delivery', error)
        }
    }

    function scheduleReceiptCheck(ctx: ExtensionContext): void {
        if (receiptTimer || !coordinator || retiring) return
        const manager = coordinator
        const pending = manager
            .list(ROOT_PATH)
            .some((agent) =>
                manager
                    .getRecordByPath(agent.path)
                    ?.pendingCompletions?.some(
                        (completion) => completion.recipient === ROOT_PATH
                    )
            )
        if (!pending) return
        const scheduledGeneration = generation
        receiptTimer = setTimeout(() => {
            receiptTimer = undefined
            if (
                scheduledGeneration !== generation ||
                manager !== coordinator ||
                retiring
            ) {
                return
            }
            // A native terminal event precedes deferred turn processing. Only
            // an idle check on the next tick can authorize resubmission.
            let idle: boolean
            try {
                idle = ctx.isIdle()
            } catch {
                // Session.dispose can invalidate a context without emitting
                // extension shutdown. Never reuse it from a deferred check.
                return
            }
            void manager
                .reconcileDeliveryReceipts(ROOT_PATH, {
                    forceRetry: idle,
                })
                .catch((error) => {
                    reportDiagnostic(
                        ctx,
                        'Cannot retry subagent delivery',
                        error
                    )
                })
        }, 0)
        receiptTimer.unref()
    }

    async function retireCoordinator(
        ctx: ExtensionContext,
        persist = true
    ): Promise<void> {
        if (retirement) return await retirement
        const manager = coordinator
        if (!manager) return
        retiring = true
        generation += 1
        if (receiptTimer) clearTimeout(receiptTimer)
        receiptTimer = undefined
        manager.detachDelivery()
        const closing = (async () => {
            if (persist) {
                try {
                    persistCheckpoint(manager, ctx)
                } catch (error) {
                    reportDiagnostic(
                        ctx,
                        'Cannot checkpoint before shutdown',
                        error
                    )
                }
            }
            try {
                await manager.shutdown()
            } catch (error) {
                // Shutdown attempts every disposal and clears runtime handles
                // even when a child finalizer fails. Preserve the graph below.
                reportDiagnostic(ctx, 'Subagent cleanup failed', error)
            }
            if (persist) persistCheckpoint(manager, ctx)
            // A failed checkpoint keeps the fenced manager available for the
            // next retirement attempt, including its final usage and outbox.
            if (coordinator === manager) coordinator = undefined
            retiring = false
        })()
        retirement = closing
        try {
            await closing
        } finally {
            if (retirement === closing) retirement = undefined
        }
    }
}
