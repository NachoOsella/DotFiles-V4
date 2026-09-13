/**
 * Pi entrypoint for Codex-style subagents (MultiAgentV2 behavioral port).
 * Thin by design: config, session-scoped manager, six collaboration tools,
 * widget/lifecycle wiring, and FINAL_ANSWER mailbox delivery. No
 * orchestration logic lives here.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { showAgentsModal } from './src/agents-modal.ts'
import { renderCommunicationText } from './src/communication.ts'
import { DEFAULT_SUBAGENTS_CONFIG } from './src/config.ts'
import {
    buildRootToolDefinitions,
    validateToolPlan,
} from './src/extension-tools.ts'
import { createPiHostLive } from './src/host-live.ts'
import { SubagentManager } from './src/manager.ts'
import { resolveMode } from './src/mode.ts'
import {
    findLatestState,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from './src/persistence.ts'
import { assembleRootPrompt } from './src/prompts.ts'
import {
    clearSubagentsWidget,
    refreshSubagentsWidget,
    setSubagentsWidgetDetail,
    toggleWidgetCollapsed,
} from './src/widget.ts'

const TOGGLE_WIDGET_SHORTCUT = 'alt+s'

function loadConfig(): typeof DEFAULT_SUBAGENTS_CONFIG {
    const config = { ...DEFAULT_SUBAGENTS_CONFIG }
    try {
        const maxConcurrent = process.env.SUBAGENTS_MAX_CONCURRENT
        if (maxConcurrent !== undefined) {
            const n = Number.parseInt(maxConcurrent, 10)
            if (Number.isSafeInteger(n) && n >= 1) {
                ;(
                    config as { maxConcurrentAgents: number }
                ).maxConcurrentAgents = n
            }
        }
        if (process.env.SUBAGENTS_DISABLE_WAIT === '1') {
            ;(config as { waitAgentEnabled: boolean }).waitAgentEnabled = false
        }
        if (process.env.SUBAGENTS_DISABLED === '1') {
            ;(config as { enabled: boolean }).enabled = false
        }
    } catch {
        // Environment overrides are best-effort.
    }
    return config
}

export default function subagentsExtension(pi: ExtensionAPI) {
    const config = loadConfig()
    if (!config.enabled) return

    let manager: SubagentManager | undefined
    let latestCtx: ExtensionContext | undefined

    const getManager = (): SubagentManager => {
        if (!manager) {
            const host = createPiHostLive({
                manager: getManager,
                getCwd: () => latestCtx?.cwd ?? process.cwd(),
                getModel: () => {
                    const model = latestCtx?.model
                    return model
                        ? {
                              provider: model.provider,
                              id: model.id,
                          }
                        : { provider: 'pi', id: 'pi-default' }
                },
                getModelRegistry: () => {
                    const registry = latestCtx?.modelRegistry
                    if (!registry) {
                        throw new Error('Model registry is unavailable')
                    }
                    return registry
                },
            })
            manager = new SubagentManager(host, config)
            manager.onEvent((event) => {
                if (latestCtx && manager) {
                    try {
                        refreshSubagentsWidget(latestCtx, manager)
                    } catch {
                        // Best-effort widget only.
                    }
                }
                // Snapshot-only methodology: persist right after every
                // child turn settles so /stats never lags wait_agent.
                if (
                    event._tag === 'ActivityCompleted' ||
                    event._tag === 'ActivityInterrupted'
                ) {
                    void persistLive()
                }
            })
        }
        return manager
    }

    const toolNames = validateToolPlan(config.waitAgentEnabled)
    const definitions = buildRootToolDefinitions(getManager()).filter((tool) =>
        toolNames.includes(tool.name)
    )
    for (const tool of definitions) {
        pi.registerTool(tool as never)
    }

    pi.registerShortcut(TOGGLE_WIDGET_SHORTCUT, {
        description: 'Collapse or expand the subagents widget',
        handler: async (ctx) => {
            const nowCollapsed = toggleWidgetCollapsed()
            refreshSubagentsWidget(ctx, getManager())
            if (ctx.hasUI) {
                ctx.ui.notify(
                    nowCollapsed
                        ? 'Agents widget: compact.'
                        : 'Agents widget: expanded.',
                    'info'
                )
            }
        },
    })

    pi.registerCommand('agents', {
        description: 'Inspect subagents. /agents [compact|detailed]',
        handler: async (args, ctx) => {
            const mode = args.trim().toLowerCase()
            if (mode === 'compact' || mode === 'detailed') {
                setSubagentsWidgetDetail(mode === 'detailed')
                refreshSubagentsWidget(ctx, getManager())
                ctx.ui.notify(`Agents widget: ${mode}.`, 'info')
                return
            }
            if (mode !== '') {
                ctx.ui.notify('Usage: /agents [compact|detailed]', 'warning')
                return
            }
            await showAgentsModal(getManager(), ctx)
        },
    })

    pi.on('session_start', (event, ctx) => {
        void event
        latestCtx = ctx
        const mgr = getManager()
        try {
            const branch = ctx.sessionManager.getBranch() as readonly unknown[]
            const persisted = findLatestState(branch)
            if (persisted) mgr.restore(persisted)
        } catch {
            // Cold start without persisted state.
        }
        refreshSubagentsWidget(ctx, mgr)
    })

    pi.on('session_tree', (_event, ctx) => {
        latestCtx = ctx
        refreshSubagentsWidget(ctx, getManager())
    })

    pi.on('session_shutdown', (event, ctx) => {
        void event
        const mgr = manager
        manager = undefined
        latestCtx = undefined
        if (!mgr) {
            try {
                clearSubagentsWidget(ctx)
            } catch {
                // Best-effort teardown.
            }
            return
        }
        // Final snapshot must include the last delta: flush usage, persist,
        // then close live sessions.
        void (async () => {
            try {
                await mgr.flushUsage()
                try {
                    pi.appendEntry(
                        SUBAGENTS_STATE_CUSTOM_TYPE,
                        mgr.serialize(ctx.sessionManager.getSessionId())
                    )
                } catch {
                    // Persistence is best-effort.
                }
            } finally {
                try {
                    clearSubagentsWidget(ctx)
                } catch {
                    // Best-effort teardown.
                }
                await mgr.shutdown()
            }
        })()
    })

    // Steering wakes wait_agent with "interrupted by new input".
    pi.on('input', (event, ctx) => {
        void event
        try {
            const mgr = manager
            if (!mgr) return
            const caller = mgr.callerFromSession(
                ctx.sessionManager.getSessionId()
            )
            mgr.notifySteer(caller)
        } catch {
            // Best-effort wake only.
        }
    })

    // Mailbox delivery at the model request boundary: queued MESSAGE and
    // FINAL_ANSWER envelopes become model-visible custom messages. Child
    // transcripts, reasoning, and tool activity never cross this boundary.
    pi.on('context', (event, ctx) => {
        const mgr = manager
        if (!mgr) return undefined
        try {
            if (ctx.sessionManager.getSessionDir() === '') return undefined
            const caller = mgr.callerFromSession(
                ctx.sessionManager.getSessionId()
            )
            const queued = mgr.drainMailbox(caller)
            if (queued.length === 0) return undefined
            const injected = queued.map((comm) => ({
                role: 'custom',
                customType: 'subagents-v2-mail',
                content: renderCommunicationText(comm),
                display: false,
                details: {
                    origin: 'subagents-v2',
                    messageType: comm.messageType,
                    author: comm.author,
                    recipient: comm.recipient,
                },
                timestamp: Date.now(),
            }))
            return { messages: [...event.messages, ...injected] as never[] }
        } catch {
            return undefined
        }
    })

    // Persist logical identities (no live handles) for lazy cold resume.
    const persist = (ctx: ExtensionContext) => {
        const mgr = manager
        if (!mgr) return
        try {
            pi.appendEntry(
                SUBAGENTS_STATE_CUSTOM_TYPE,
                mgr.serialize(ctx.sessionManager.getSessionId())
            )
        } catch {
            // Persistence is best-effort.
        }
    }
    // Live flush used by subagent lifecycle events: capture usage first so
    // the snapshot never lags a settled child turn (snapshot-only /stats).
    // Function declaration (hoisted) so getManager() can reference it.
    async function persistLive() {
        const ctx = latestCtx
        const mgr = manager
        if (!ctx || !mgr) return
        try {
            await mgr.flushUsage()
        } catch {
            // Fall through with last known totals.
        }
        try {
            pi.appendEntry(
                SUBAGENTS_STATE_CUSTOM_TYPE,
                mgr.serialize(ctx.sessionManager.getSessionId())
            )
        } catch {
            // Persistence is best-effort.
        }
    }
    pi.on('agent_settled', (_event, ctx) => {
        persist(ctx)
        refreshSubagentsWidget(ctx, getManager())
    })
    pi.on('tool_result', (_event, ctx) => {
        refreshSubagentsWidget(ctx, getManager())
    })

    // Root developer context appended to the assembled system prompt.
    // Mode resolves to explicit-only (no verified Ultra equivalent in Pi).
    pi.on('before_agent_start', (event, ctx) => {
        void ctx
        getManager()
        const fragment = assembleRootPrompt({
            config,
            mode: resolveMode({
                ultraReasoning: false,
                customModeHint: config.multiAgentModeHintText,
            }),
            activeSlotCount: config.maxConcurrentAgents,
        })
        return { systemPrompt: `${event.systemPrompt}\n\n${fragment}` }
    })
}
