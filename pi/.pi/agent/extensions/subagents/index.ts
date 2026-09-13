import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { showAgentsModal } from './src/agents-modal.ts'
import { DEFAULT_SUBAGENTS_CONFIG } from './src/config.ts'
import { SubagentCoordinator } from './src/coordinator.ts'
import {
    buildRootToolDefinitions,
    buildChildToolDefinitions,
    validateToolPlan,
} from './src/extension-tools.ts'
import { rootEndpoint } from './src/transport.ts'
import { resolveConfiguredMode } from './src/mode.ts'
import {
    findLatestState,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from './src/persistence.ts'
import { assembleRootPrompt } from './src/prompts.ts'
import type { AgentPath } from './src/ids.ts'
import {
    clearSubagentsWidget,
    refreshSubagentsWidget,
    setSubagentsWidgetDetail,
    toggleWidgetCollapsed,
} from './src/widget.ts'
import type { ParentExecutionSnapshot } from './src/parent-snapshot.ts'

const TOGGLE_WIDGET_SHORTCUT = 'alt+s'
const ROOT_PATH = '/root' as AgentPath

function loadConfig(): typeof DEFAULT_SUBAGENTS_CONFIG {
    const config = { ...DEFAULT_SUBAGENTS_CONFIG }
    const maxConcurrent = process.env.SUBAGENTS_MAX_CONCURRENT
    if (maxConcurrent !== undefined) {
        const value = Number.parseInt(maxConcurrent, 10)
        if (Number.isSafeInteger(value) && value >= 1) {
            ;(
                config as { maxConcurrentExecutions: number }
            ).maxConcurrentExecutions = value
            ;(config as { maxConcurrentAgents: number }).maxConcurrentAgents =
                value
        }
    }
    if (process.env.SUBAGENTS_MAX_AGENTS !== undefined) {
        const value = Number.parseInt(process.env.SUBAGENTS_MAX_AGENTS, 10)
        if (Number.isSafeInteger(value) && value >= 1) {
            ;(config as { maxAgents: number }).maxAgents = value
        }
    }
    if (process.env.SUBAGENTS_MAX_DEPTH !== undefined) {
        const value = Number.parseInt(process.env.SUBAGENTS_MAX_DEPTH, 10)
        if (Number.isSafeInteger(value) && value >= 0) {
            ;(config as { maxDepth: number }).maxDepth = value
        }
    }
    if (process.env.SUBAGENTS_MAX_LOADED !== undefined) {
        const value = Number.parseInt(process.env.SUBAGENTS_MAX_LOADED, 10)
        if (Number.isSafeInteger(value) && value >= 1) {
            ;(config as { maxLoadedAgents: number }).maxLoadedAgents = value
            ;(config as { maxResidentAgents: number }).maxResidentAgents = value
        }
    }
    if (process.env.SUBAGENTS_DISABLE_WAIT === '1') {
        ;(config as { waitAgentEnabled: boolean }).waitAgentEnabled = false
    }
    if (process.env.SUBAGENTS_DISABLED === '1') {
        ;(config as { enabled: boolean }).enabled = false
    }
    return config
}

export default function subagentsExtension(pi: ExtensionAPI) {
    const config = loadConfig()
    if (!config.enabled) return

    let coordinator: SubagentCoordinator | undefined
    let latestCtx: ExtensionContext | undefined

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
            contextEntries: ctx.sessionManager.buildContextEntries(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionId: ctx.sessionManager.getSessionId(),
        }
    }

    const getCoordinator = (): SubagentCoordinator => {
        if (!coordinator) {
            coordinator = new SubagentCoordinator({
                config,
                getRootSnapshot: rootSnapshot,
                rootEndpoint: rootEndpoint(ROOT_PATH, (message, options) => {
                    pi.sendMessage(message, options)
                }),
                rootSessionId: () =>
                    latestCtx?.sessionManager.getSessionId() ?? 'unknown-root',
                rootSessionDir: () =>
                    latestCtx?.sessionManager.getSessionDir() ?? '',
                getModelRegistry: () => {
                    if (!latestCtx)
                        throw new Error('Root Pi session is not ready.')
                    return latestCtx.modelRegistry
                },
                buildTools: (caller) =>
                    buildChildToolDefinitions(getCoordinator(), caller),
            })
            coordinator.onEvent((event) => {
                const ctx = latestCtx
                if (ctx) refreshSubagentsWidget(ctx, getCoordinator())
                if (
                    event._tag === 'ActivityCompleted' ||
                    event._tag === 'ActivityInterrupted'
                ) {
                    void persistLive()
                }
            })
        }
        return coordinator
    }

    const toolNames = validateToolPlan(config.waitAgentEnabled)
    for (const tool of buildRootToolDefinitions(getCoordinator())) {
        if (toolNames.includes(tool.name)) pi.registerTool(tool as never)
    }

    pi.registerShortcut(TOGGLE_WIDGET_SHORTCUT, {
        description: 'Collapse or expand the subagents widget',
        handler: async (ctx) => {
            const nowCollapsed = toggleWidgetCollapsed()
            refreshSubagentsWidget(ctx, getCoordinator())
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
        description: 'Inspect subagents',
        handler: async (args, ctx) => {
            const mode = args.trim().toLowerCase()
            if (mode === 'compact' || mode === 'detailed') {
                setSubagentsWidgetDetail(mode === 'detailed')
                refreshSubagentsWidget(ctx, getCoordinator())
                return
            }
            if (mode !== '') {
                ctx.ui.notify('Usage: /agents [compact|detailed]', 'warning')
                return
            }
            await showAgentsModal(getCoordinator(), ctx)
        },
    })

    pi.on('session_start', (event, ctx) => {
        latestCtx = ctx
        const manager = getCoordinator()
        manager.bindSession(ctx.sessionManager.getSessionId(), ROOT_PATH)
        if (event.reason === 'startup' || event.reason === 'resume') {
            const persisted = findLatestState(ctx.sessionManager.getBranch())
            if (persisted) manager.restore(persisted)
        }
        refreshSubagentsWidget(ctx, manager)
    })

    pi.on('session_tree', (_event, ctx) => {
        latestCtx = ctx
        refreshSubagentsWidget(ctx, getCoordinator())
    })

    pi.on('input', (_event, ctx) => {
        latestCtx = ctx
        getCoordinator().notifySteer(
            getCoordinator().callerFromSession(
                ctx.sessionManager.getSessionId()
            )
        )
    })

    pi.on('agent_settled', (_event, ctx) => {
        latestCtx = ctx
        void persistLive()
        refreshSubagentsWidget(ctx, getCoordinator())
    })

    pi.on('tool_result', (_event, ctx) => {
        latestCtx = ctx
        refreshSubagentsWidget(ctx, getCoordinator())
    })

    pi.on('before_agent_start', (event, ctx) => {
        latestCtx = ctx
        const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel()
        const fragment = assembleRootPrompt({
            config,
            mode: resolveConfiguredMode(config, thinking),
            activeSlotCount: config.maxConcurrentExecutions,
        })
        return { systemPrompt: `${event.systemPrompt}\n\n${fragment}` }
    })

    pi.on('session_shutdown', (_event, ctx) => {
        const manager = coordinator
        const sessionId = ctx.sessionManager.getSessionId()
        coordinator = undefined
        latestCtx = undefined
        if (!manager) {
            clearSubagentsWidget(ctx)
            return
        }
        void (async () => {
            try {
                pi.appendEntry(
                    SUBAGENTS_STATE_CUSTOM_TYPE,
                    manager.serialize(sessionId)
                )
            } finally {
                clearSubagentsWidget(ctx)
                await manager.shutdown()
            }
        })()
    })

    async function persistLive(): Promise<void> {
        const ctx = latestCtx
        const manager = coordinator
        if (!ctx || !manager) return
        try {
            pi.appendEntry(
                SUBAGENTS_STATE_CUSTOM_TYPE,
                manager.serialize(ctx.sessionManager.getSessionId())
            )
        } catch {
            // Persistence is best effort during session transitions.
        }
    }
}
