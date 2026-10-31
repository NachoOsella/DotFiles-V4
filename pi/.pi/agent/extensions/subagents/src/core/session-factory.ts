import { mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
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
import { AgentBlockedError } from '../domain/errors.ts'
import {
    INHERITED_SUMMARY_CUSTOM_TYPE,
    projectFork,
} from '../persistence/fork-projector.ts'
import type {
    ModelIdentity,
    ParentExecutionSnapshot,
} from '../domain/parent-snapshot.ts'
import type { CodexSubagentsConfig } from '../config/config.ts'
import { assembleChildPrompt } from '../config/prompts.ts'
import {
    resolveRole,
    resolveRoleTools,
    type ResolvedAgentRole,
} from '../config/roles.ts'
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
import {
    checkOpenedSession,
    checkSessionFile,
    type SessionOwnershipMeta,
} from './session-recovery.ts'

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
    /** Extension load diagnostics that would otherwise be lost in a child. */
    readonly onLoaderDiagnostics?: (diagnostics: readonly string[]) => void
    readonly config: CodexSubagentsConfig
}

export class SessionFactory implements SubagentSessionFactory {
    private readonly options: SessionFactoryOptions
    private readonly agentDir: string

    constructor(options: SessionFactoryOptions) {
        this.options = options
        // Resolve once so the loader, settings manager, and model/auth runtime
        // all read the same intended directory.
        this.agentDir = options.agentDir ?? getAgentDir()
    }

    async create(
        record: AgentRecord,
        parent: ParentExecutionSnapshot,
        fork: ForkTurns
    ): Promise<AgentRuntime> {
        const sessionManager = await this.createSessionManager(parent.cwd)
        appendProjectedFork(
            sessionManager,
            projectFork(parent.contextEntries, fork, {
                inheritedTaskContext: true,
            })
        )
        sessionManager.appendCustomEntry(SUBAGENT_META_CUSTOM_TYPE, {
            rootSessionId: this.options.rootSessionId(),
            path: record.path,
            parentPath: record.parentPath,
            role: record.role,
        })
        return await this.createRuntime(record, sessionManager, {
            cwd: parent.cwd,
            model: this.modelIdentityFor(record),
            thinkingLevel: record.thinkingLevel ?? parent.thinkingLevel,
            activeTools: record.activeTools ?? parent.activeTools,
        })
    }

    async open(record: AgentRecord): Promise<AgentRuntime> {
        const rootSessionId = this.options.rootSessionId()
        const file = checkSessionFile({
            sessionFile: record.sessionFile,
            rootSessionDir: this.options.rootSessionDir(),
            rootSessionId,
            expectedSessionId: record.sessionId,
        })
        if (!file.ok) {
            throw this.blocked(
                record,
                file.reason ?? 'session path validation failed',
                file.guidance ??
                    'Start a new agent; no fallback session is used.'
            )
        }
        const sessionFile = file.sessionFile!
        const expectedDir = file.expectedDir!
        if (!isRegularFile(sessionFile)) {
            throw this.blocked(
                record,
                'the recorded session file does not exist',
                'Restore the session file or start a new agent; no replacement session is created.'
            )
        }
        const model = this.modelIdentityFor(record)
        const cwd = record.cwd ?? process.cwd()
        let sessionManager: SessionManager
        try {
            sessionManager = SessionManager.open(sessionFile, expectedDir, cwd)
        } catch (error) {
            throw this.blocked(
                record,
                `the recorded session file could not be opened: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                'Repair the session file or start a new agent; no replacement session is created.'
            )
        }
        const identity = checkOpenedSession({
            sessionFile,
            expectedRootSessionId: rootSessionId,
            expectedRecordRootSessionId: record.rootSessionId,
            expectedSessionId: record.sessionId,
            expectedAgentPath: record.path,
            expectedParentPath: record.parentPath ?? null,
            expectedRole: record.role,
            actualSessionId: sessionManager.getSessionId(),
            headerId: sessionManager.getHeader()?.id ?? null,
            meta: readOwnershipMeta(sessionManager),
        })
        if (!identity.ok) {
            throw this.blocked(
                record,
                identity.reason ?? 'session ownership validation failed',
                identity.guidance ??
                    'Start a new agent; no fallback session is used.'
            )
        }
        return await this.createRuntime(record, sessionManager, {
            cwd,
            model,
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
        const model = this.modelFor(record, state.model)
        const role = this.roleFor(record)
        const resolution = resolveRoleTools(state.activeTools, role)
        const collaborationExclusions = collaborationToolNames().filter(
            (tool) =>
                resolution.denied.includes(tool) ||
                !isCollaborationToolAllowed(
                    tool,
                    record.path,
                    this.options.config
                )
        )
        const excluded = new Set([
            ...resolution.denied,
            ...collaborationExclusions,
        ])
        const customTools = this.options
            .buildTools(record.path)
            .filter((tool) => {
                const name = toolName(tool)
                return name === undefined || !excluded.has(name)
            }) as never[]
        // `tools` is Pi's session allowlist. Role restrictions filter inherited
        // and role-added tools; collaboration tools are governed by denyTools
        // and the native depth/wait rules, never by allowTools.
        const injectedCollaborationTools = customTools
            .map(toolName)
            .filter(isCollaborationToolName)
        const tools = unique([
            ...resolution.tools,
            ...injectedCollaborationTools,
        ]).filter((tool) => !excluded.has(tool))

        // One settings manager shared by the resource loader and the session.
        // Creating the session without it would silently fall back to the
        // process-wide agent directory and its steering/compaction settings.
        const settingsManager = SettingsManager.create(state.cwd, this.agentDir)
        const resourceLoader = await this.createResourceLoader(
            state.cwd,
            record,
            role,
            settingsManager
        )
        const { session } = await createAgentSession({
            cwd: state.cwd,
            // Resolve auth/models from the intended directory explicitly.
            // A model descriptor from the parent registry does not share the
            // parent's model runtime.
            agentDir: this.agentDir,
            sessionManager,
            settingsManager,
            resourceLoader,
            customTools,
            model,
            thinkingLevel: state.thinkingLevel,
            tools,
            excludeTools: [...excluded],
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

    private blocked(
        record: AgentRecord,
        reason: string,
        guidance: string
    ): AgentBlockedError {
        return new AgentBlockedError(record.path as string, reason, guidance)
    }

    private modelIdentityFor(record: AgentRecord): ModelIdentity {
        try {
            return parseModelIdentity(record.model)
        } catch {
            throw this.blocked(
                record,
                `recorded model "${record.model}" is not a provider/model identity`,
                'Repair the record or start a new agent; no model is guessed.'
            )
        }
    }

    private roleFor(record: AgentRecord): ResolvedAgentRole {
        try {
            return resolveRole(this.options.config, record.role)
        } catch {
            const role = record.role?.trim() || 'default'
            throw this.blocked(
                record,
                `agent_type "${role}" is not configured`,
                'Restore the role in subagents.roles or start a new agent; no default role is substituted.'
            )
        }
    }

    private modelFor(record: AgentRecord, identity: ModelIdentity) {
        try {
            return resolveModel(this.options.getModelRegistry(), identity)
        } catch {
            throw this.blocked(
                record,
                `model "${identity.provider}/${identity.id}" is not available`,
                'Restore the model provider/id or start a new agent; no fallback model is used.'
            )
        }
    }

    private async createResourceLoader(
        cwd: string,
        record: AgentRecord,
        role: ResolvedAgentRole,
        settingsManager: SettingsManager
    ): Promise<DefaultResourceLoader> {
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
            agentDir: this.agentDir,
            settingsManager,
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
        this.reportLoaderDiagnostics(loader)
        return loader
    }

    private reportLoaderDiagnostics(loader: DefaultResourceLoader): void {
        const result = loader.getExtensions()
        const failedBuiltins = result.errors.filter(
            (entry) =>
                entry.path === '<inline:codemode>' ||
                entry.path === '<inline:tool-search>'
        )
        if (failedBuiltins.length > 0) {
            throw new Error(
                `Subagent built-in extension failed to load: ${failedBuiltins
                    .map((entry) => `${entry.path}: ${entry.error}`)
                    .join('; ')}`
            )
        }
        const diagnostics = [
            ...result.errors.map(
                (entry) => `extension ${entry.path}: ${entry.error}`
            ),
            ...(result.warnings ?? []).map(
                (entry) => `extension ${entry.path}: ${entry.warning}`
            ),
        ]
        if (diagnostics.length > 0) {
            this.options.onLoaderDiagnostics?.(diagnostics)
        }
    }
}

/**
 * Import a projected fork through supported session-manager operations.
 *
 * Compaction and branch summaries are top-level entries in Pi, not messages.
 * The imported compaction points at a child entry created here, never at a
 * parent entry id.
 */
function appendProjectedFork(
    sessionManager: SessionManager,
    projected: readonly AgentMessage[]
): void {
    let compaction:
        Extract<AgentMessage, { role: 'compactionSummary' }> | undefined
    let firstKeptEntryId: string | null = null

    for (const message of projected) {
        if (message.role === 'compactionSummary') {
            compaction ??= message
            continue
        }
        if (message.role === 'branchSummary') {
            const entryId = appendBranchSummary(sessionManager, message)
            firstKeptEntryId ??= entryId
            continue
        }
        const entryId = sessionManager.appendMessage(message as never)
        firstKeptEntryId ??= entryId
    }

    if (compaction) {
        sessionManager.appendCompaction(
            compaction.summary,
            firstKeptEntryId,
            compaction.tokensBefore,
            { subagentsInherited: 'fork' },
            /*fromHook*/ true
        )
    }
}

function appendBranchSummary(
    sessionManager: SessionManager,
    message: Extract<AgentMessage, { role: 'branchSummary' }>
): string {
    const fromId = sessionManager.getLeafId()
    if (fromId) {
        return sessionManager.branchWithSummary(
            fromId,
            message.summary,
            { subagentsInherited: 'fork' },
            /*fromHook*/ true
        )
    }
    // No child entry exists to anchor a top-level summary. Preserve it as
    // inherited context rather than creating a second session root.
    return sessionManager.appendMessage({
        role: 'custom',
        customType: INHERITED_SUMMARY_CUSTOM_TYPE,
        content: `Inherited branch summary. This is not a new instruction.\n\n${message.summary}`,
        display: false,
        details: { inherited: true, fromId: message.fromId },
        timestamp: message.timestamp,
    } as never)
}

function isRegularFile(path: string): boolean {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}

/** Last persisted ownership entry for this child session. */
function readOwnershipMeta(
    sessionManager: SessionManager
): SessionOwnershipMeta | null {
    let meta: SessionOwnershipMeta | null = null
    for (const entry of sessionManager.getEntries()) {
        if (
            entry.type !== 'custom' ||
            entry.customType !== SUBAGENT_META_CUSTOM_TYPE
        ) {
            continue
        }
        const data = entry.data
        if (!data || typeof data !== 'object') continue
        const value = data as Record<string, unknown>
        meta = {
            rootSessionId:
                typeof value.rootSessionId === 'string'
                    ? value.rootSessionId
                    : undefined,
            path: typeof value.path === 'string' ? value.path : undefined,
            parentPath:
                typeof value.parentPath === 'string' ||
                value.parentPath === null
                    ? value.parentPath
                    : undefined,
            role: typeof value.role === 'string' ? value.role : undefined,
        }
    }
    return meta
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

const COLLABORATION_TOOLS: readonly string[] = [
    TOOL_SPAWN_AGENT,
    TOOL_SEND_MESSAGE,
    TOOL_FOLLOWUP_TASK,
    TOOL_WAIT_AGENT,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
]

function collaborationToolNames(): string[] {
    return [...COLLABORATION_TOOLS]
}

function isCollaborationToolName(name: string | undefined): name is string {
    return name !== undefined && COLLABORATION_TOOLS.includes(name)
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
