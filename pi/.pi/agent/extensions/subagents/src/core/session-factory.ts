import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import {
    createAgentSession,
    createCodemodeExtension,
    createToolSearchExtension,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { ForkTurns } from '../domain/communication.ts'
import { projectFork } from '../persistence/fork-projector.ts'
import type {
    ModelIdentity,
    ParentExecutionSnapshot,
} from '../domain/parent-snapshot.ts'
import type { CodexSubagentsConfig } from '../config/config.ts'
import { assembleChildPrompt } from '../config/prompts.ts'
import { resolveRole } from '../config/roles.ts'
import { resolveConfiguredMode } from '../config/mode.ts'
import {
    TOOL_FOLLOWUP_TASK,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
    TOOL_SEND_MESSAGE,
    TOOL_SPAWN_AGENT,
    TOOL_WAIT_AGENT,
} from '../tools/tool-specs.ts'
import {
    makeAgentRuntime,
    type AgentRuntime,
    type LiveActivity,
} from './agent-runtime.ts'

import { SUBAGENT_META_CUSTOM_TYPE } from '../persistence/session-state.ts'

/**
 * Injected factories must not start unobserved model work before returning.
 * The default factory attaches supervision before emitting session_start.
 */
export interface SubagentSessionFactory {
    create(
        record: AgentRecord,
        parent: ParentExecutionSnapshot,
        fork: ForkTurns
    ): Promise<AgentRuntime>
    open(record: AgentRecord): Promise<AgentRuntime>
}

interface SessionFactoryOptions {
    readonly rootSessionId: () => string
    readonly rootSessionDir: () => string
    readonly getModelRegistry: () => ModelRegistry
    readonly buildTools: (path: AgentRecord['path']) => readonly unknown[]
    /** Agent directory for child settings and resources. Defaults to this process's. */
    readonly agentDir?: string
    readonly onActivity?: (
        path: AgentRecord['path'],
        activity: LiveActivity
    ) => void
    /** Observe native turns before session_start handlers can trigger them. */
    readonly onRuntimeCreated?: (
        record: AgentRecord,
        runtime: AgentRuntime
    ) => void
    readonly config: CodexSubagentsConfig
}

export class SessionFactory implements SubagentSessionFactory {
    private readonly options: SessionFactoryOptions

    constructor(options: SessionFactoryOptions) {
        this.options = options
    }

    async create(
        record: AgentRecord,
        parent: ParentExecutionSnapshot,
        fork: ForkTurns
    ): Promise<AgentRuntime> {
        const sessionManager = await this.createSessionManager(parent.cwd)
        const entries = projectFork(parent.contextEntries, fork)
        for (const message of entries) {
            sessionManager.appendMessage(message as never)
        }
        sessionManager.appendCustomEntry(SUBAGENT_META_CUSTOM_TYPE, {
            rootSessionId: this.options.rootSessionId(),
            path: record.path,
            parentPath: record.parentPath,
            role: record.role,
        })
        return await this.createRuntime(record, sessionManager, {
            cwd: parent.cwd,
            model: parseModelIdentity(record.model),
            thinkingLevel: record.thinkingLevel ?? parent.thinkingLevel,
            activeTools: record.activeTools ?? parent.activeTools,
        })
    }

    async open(record: AgentRecord): Promise<AgentRuntime> {
        if (!record.sessionFile) {
            throw new Error(`Agent ${record.path} has no persistent session.`)
        }
        const cwd = record.cwd ?? process.cwd()
        const sessionDir = this.options.rootSessionDir()
        const sessionManager = SessionManager.open(
            record.sessionFile,
            sessionDir || undefined,
            cwd
        )
        return await this.createRuntime(record, sessionManager, {
            cwd,
            model: parseModelIdentity(record.model),
            thinkingLevel: record.thinkingLevel ?? 'medium',
            activeTools: record.activeTools ?? [],
        })
    }

    private async createSessionManager(cwd: string): Promise<SessionManager> {
        const rootDir = this.options.rootSessionDir()
        if (!rootDir) return SessionManager.inMemory(cwd)
        const sessionDir = join(
            rootDir,
            '.subagents',
            this.options.rootSessionId()
        )
        await mkdir(sessionDir, { recursive: true })
        return SessionManager.create(cwd, sessionDir)
    }

    private async createRuntime(
        record: AgentRecord,
        sessionManager: SessionManager,
        state: {
            cwd: string
            model: ModelIdentity
            thinkingLevel: ThinkingLevel
            activeTools: readonly string[]
        }
    ): Promise<AgentRuntime> {
        const model = resolveModel(this.options.getModelRegistry(), state.model)
        const disallowedCollaborationTools = collaborationToolNames().filter(
            (tool) =>
                !isCollaborationToolAllowed(
                    tool,
                    record.path,
                    this.options.config
                )
        )
        const disallowed = new Set(disallowedCollaborationTools)
        const customTools = this.options
            .buildTools(record.path)
            .filter((tool) => {
                const name = toolName(tool)
                return name === undefined || !disallowed.has(name)
            }) as never[]
        // Pi treats `tools` as an allowlist for built-in and custom tools. Keep
        // inherited tools while adding permitted child collaboration tools.
        const tools = unique([
            ...state.activeTools,
            ...customTools
                .map(toolName)
                .filter((name): name is string => name !== undefined),
        ]).filter((tool) => !disallowed.has(tool))
        const resourceLoader = await this.createResourceLoader(
            state.cwd,
            record
        )
        const { session } = await createAgentSession({
            cwd: state.cwd,
            sessionManager,
            resourceLoader,
            customTools,
            model,
            thinkingLevel: state.thinkingLevel,
            tools,
            excludeTools: disallowedCollaborationTools,
        })
        const runtime = makeAgentRuntime({
            path: record.path,
            session,
            runSequence: record.runSequence ?? 0,
            onActivity: (activity) =>
                this.options.onActivity?.(record.path, activity),
        })
        try {
            this.options.onRuntimeCreated?.(record, runtime)
            // Emits session_start for the child's own extensions. Without it,
            // built-ins such as codemode never finish wiring themselves up.
            await session.bindExtensions({})
        } catch (error) {
            await runtime.dispose()
            throw error
        }
        return runtime
    }

    private async createResourceLoader(
        cwd: string,
        record: AgentRecord
    ): Promise<DefaultResourceLoader> {
        const role = resolveRole(this.options.config, record.role)
        const agentDir = this.options.agentDir ?? getAgentDir()
        const rolePrompt = [
            assembleChildPrompt({
                config: this.options.config,
                mode: resolveConfiguredMode(
                    this.options.config,
                    record.thinkingLevel ?? 'medium'
                ),
                activeSlotCount: this.options.config.maxConcurrentExecutions,
                currentDepth: nestingDepth(record.path),
            }),
            `Your agent path is ${record.path}. Your direct parent is ${record.parentPath ?? '/root'}.`,
            record.role
                ? `Your assigned agent type is ${record.role}.`
                : undefined,
            role.promptAppend,
        ]
            .filter((part): part is string => Boolean(part && part.trim()))
            .join('\n\n')

        const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager: SettingsManager.create(cwd, agentDir),
            noThemes: true,
            // Local tool orchestration only: codemode and tool search load as the
            // host's built-ins, so an `extensions` entry such as
            // `-builtin:codemode` still disables them. MCP is deliberately absent
            // so children never read mcp.json or open a server.
            extensionFactories: [
                {
                    name: 'codemode',
                    factory: createCodemodeExtension(),
                    builtin: true,
                    replaceable: true,
                },
                {
                    name: 'tool-search',
                    factory: createToolSearchExtension(),
                    builtin: true,
                    replaceable: true,
                },
            ],
            extensionsOverride: (base) => ({
                ...base,
                extensions: base.extensions.filter(
                    (extension) =>
                        !isSubagentsExtensionPath(
                            extension.resolvedPath ?? extension.path ?? ''
                        )
                ),
            }),
            appendSystemPromptOverride: (base) => [...base, rolePrompt],
        })
        await loader.reload()
        return loader
    }
}

function parseModelIdentity(value: string): ModelIdentity {
    const separator = value.indexOf('/')
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid model identity "${value}".`)
    }
    return {
        provider: value.slice(0, separator),
        id: value.slice(separator + 1),
    }
}

function resolveModel(registry: ModelRegistry, identity: ModelIdentity) {
    const model = registry.find(identity.provider, identity.id)
    if (!model) {
        throw new Error(
            `Unknown model "${identity.provider}/${identity.id}" for subagent.`
        )
    }
    return model
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)]
}

function collaborationToolNames(): string[] {
    return [
        TOOL_SPAWN_AGENT,
        TOOL_SEND_MESSAGE,
        TOOL_FOLLOWUP_TASK,
        TOOL_WAIT_AGENT,
        TOOL_INTERRUPT_AGENT,
        TOOL_LIST_AGENTS,
    ]
}

function isCollaborationToolAllowed(
    tool: string,
    path: AgentRecord['path'],
    config: CodexSubagentsConfig
): boolean {
    if (tool === TOOL_SPAWN_AGENT) {
        return nestingDepth(path) < config.maxDepth
    }
    if (tool === TOOL_WAIT_AGENT) return config.waitAgentEnabled
    return true
}

function toolName(tool: unknown): string | undefined {
    if (!tool || typeof tool !== 'object') return undefined
    const name = (tool as { name?: unknown }).name
    return typeof name === 'string' ? name : undefined
}

function nestingDepth(path: AgentRecord['path']): number {
    return path.split('/').filter(Boolean).length - 2
}

function isSubagentsExtensionPath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/')
    return normalized.endsWith('/extensions/subagents/index.ts')
}
