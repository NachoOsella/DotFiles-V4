import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { showAgentsModal } from './src/ui/agents-modal.ts'
import { decodeConfig, DEFAULT_SUBAGENTS_CONFIG } from './src/config/config.ts'
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
import { renderSubagentsState } from './src/ui/state-renderer.ts'
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

const ROOT_PATH = '/root' as AgentPath

function loadConfig(): typeof DEFAULT_SUBAGENTS_CONFIG {
    const config = decodeConfig(readConfiguredConfig())
    const maxConcurrent = process.env.SUBAGENTS_MAX_CONCURRENT
    if (maxConcurrent !== undefined) {
        const value = Number.parseInt(maxConcurrent, 10)
        if (Number.isSafeInteger(value) && value >= 1) {
            ;(
                config as { maxConcurrentExecutions: number }
            ).maxConcurrentExecutions = value
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

function readConfiguredConfig(): unknown {
    const configured = process.env.SUBAGENTS_CONFIG
    if (configured !== undefined) {
        try {
            return JSON.parse(configured)
        } catch {
            return undefined
        }
    }
    try {
        const configPath = process.env.SUBAGENTS_CONFIG_PATH
        const settings = JSON.parse(
            readFileSync(
                configPath ?? join(getAgentDir(), 'settings.json'),
                'utf8'
            )
        ) as unknown
        return configPath ? settings : selectSubagentsConfig(settings)
    } catch {
        return undefined
    }
}

function selectSubagentsConfig(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    return record.subagents
}

export default function subagentsExtension(pi: ExtensionAPI) {
    const config = loadConfig()
    if (!config.enabled) return

    pi.registerMessageRenderer(
        SUBAGENTS_COMMUNICATION_CUSTOM_TYPE,
        renderSubagentCommunication
    )
    pi.registerEntryRenderer(SUBAGENTS_STATE_CUSTOM_TYPE, renderSubagentsState)

    let coordinator: SubagentCoordinator | undefined
    let latestCtx: ExtensionContext | undefined

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
        if (!coordinator) {
            coordinator = new SubagentCoordinator({
                config,
                getRootSnapshot: rootSnapshot,
                rootEndpoint: rootEndpoint(ROOT_PATH, (message, options) => {
                    pi.sendMessage(message, options)
                }),
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
                    buildChildToolDefinitions(getCoordinator(), caller),
            })
            coordinator.onEvent((event) => {
                if (
                    event._tag === 'StatusChanged' ||
                    event._tag === 'UsageUpdated'
                ) {
                    const manager = coordinator
                    if (manager) publishSubagentInfo(manager)
                }
                if (
                    event._tag === 'UsageUpdated' ||
                    event._tag === 'ActivityCompleted' ||
                    event._tag === 'ActivityInterrupted'
                ) {
                    void persistLive()
                }
            })
        }
        return coordinator
    }

    const toolNames = plannedToolNames(config.waitAgentEnabled)
    for (const tool of buildRootToolDefinitions(getCoordinator())) {
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

    pi.on('session_start', (event, ctx) => {
        latestCtx = ctx
        const manager = getCoordinator()
        manager.bindSession(ctx.sessionManager.getSessionId(), ROOT_PATH)
        if (
            event.reason === 'startup' ||
            event.reason === 'resume' ||
            event.reason === 'reload'
        ) {
            const persisted = findLatestState(ctx.sessionManager.getBranch())
            if (persisted) manager.restore(persisted)
        }
        publishSubagentInfo(manager)
        void manager.retryPendingCompletions(ROOT_PATH)
    })

    pi.on('session_tree', (_event, ctx) => {
        latestCtx = ctx
        if (coordinator) publishSubagentInfo(coordinator)
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

    pi.on('agent_settled', (_event, ctx) => {
        latestCtx = ctx
        void persistLive()
    })

    pi.on('tool_result', (_event, ctx) => {
        latestCtx = ctx
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

    pi.on('session_shutdown', async (_event, ctx) => {
        const manager = coordinator
        const sessionId = ctx.sessionManager.getSessionId()
        stopRefresh()
        coordinator = undefined
        latestCtx = undefined
        pi.events.emit(SUBAGENTS_INFO_CHANNEL, { running: 0 })
        if (!manager) return
        try {
            pi.appendEntry(
                SUBAGENTS_STATE_CUSTOM_TYPE,
                manager.serialize(sessionId)
            )
        } catch {
            // Persistence is best effort during session transitions.
        } finally {
            await manager.shutdown()
        }
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
