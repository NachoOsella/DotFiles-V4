import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentRecord } from './agent-record.ts'
import type { ForkTurns } from './communication.ts'
import { projectFork } from './fork-projector.ts'
import type {
    ModelIdentity,
    ParentExecutionSnapshot,
} from './parent-snapshot.ts'
import type { CodexSubagentsConfig } from './config.ts'
import { assembleChildPrompt } from './prompts.ts'
import { resolveRole } from './roles.ts'
import { resolveConfiguredMode } from './mode.ts'
import { makeAgentRuntime, type AgentRuntime } from './agent-runtime.ts'

export const SUBAGENT_META_CUSTOM_TYPE = 'subagents-v3-agent-meta'

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
    readonly onActivity?: (path: AgentRecord['path'], summary: string) => void
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
            if (record.legacyUnresumable) {
                throw new Error(
                    `Agent ${record.path} was created by the legacy subagents runtime and has no persistent child session. Spawn a new agent instead.`
                )
            }
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
        const customTools = this.options.buildTools(record.path) as never[]
        // Register every collaboration tool so role changes can select it,
        // but activate only the names inherited from the caller snapshot.
        const tools = unique([...state.activeTools])
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
        })
        return makeAgentRuntime({
            path: record.path,
            session,
            runSequence: record.runSequence ?? 0,
            onActivity: (summary) =>
                this.options.onActivity?.(record.path, summary),
        })
    }

    private async createResourceLoader(
        cwd: string,
        record: AgentRecord
    ): Promise<DefaultResourceLoader> {
        const role = resolveRole(this.options.config, record.role)
        const rolePrompt = [
            assembleChildPrompt({
                config: this.options.config,
                mode: resolveConfiguredMode(
                    this.options.config,
                    record.thinkingLevel ?? 'medium'
                ),
                activeSlotCount: this.options.config.maxConcurrentExecutions,
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
            agentDir: getAgentDir(),
            settingsManager: SettingsManager.create(cwd, getAgentDir()),
            noThemes: true,
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

function isSubagentsExtensionPath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/')
    return normalized.endsWith('/extensions/subagents/index.ts')
}
