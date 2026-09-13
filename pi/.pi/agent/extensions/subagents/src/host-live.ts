/**
 * Real Pi host adapter. The only file allowed to know Pi's concrete
 * agent/session interfaces. All orchestration stays in manager.ts.
 *
 * Each child gets an independent in-memory AgentSession via the Pi SDK.
 * Collaboration tools are registered inside child sessions so nested
 * agents can recursively spawn. History forking copies the parent's
 * branch text; typed agent_message transport is a known parity gap
 * (see docs/CODEX_PARITY.md) and uses narrow custom-message injection.
 */

import type {
    AgentSession,
    Extension,
    LoadExtensionsResult,
    ModelRegistry,
} from '@earendil-works/pi-coding-agent'
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentPath } from './ids.ts'
import type { ForkTurns } from './communication.ts'
import {
    emptySessionUsage,
    selectForkHistory,
    type HostSessionHandle,
    type PiHost,
    type SessionUsage,
} from './host.ts'
import type { SubagentManager } from './manager.ts'
import { buildChildToolDefinitions } from './extension-tools.ts'

interface LiveSession extends HostSessionHandle {
    session: AgentSession
}

const THINKING_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const

type ThinkingLevel = (typeof THINKING_LEVELS)[number]

function parseThinkingLevel(
    value: string | undefined
): ThinkingLevel | undefined {
    if (value === undefined) return undefined
    if ((THINKING_LEVELS as readonly string[]).includes(value)) {
        return value as ThinkingLevel
    }
    throw new Error(
        `Invalid reasoning_effort "${value}": use ${THINKING_LEVELS.join(', ')}`
    )
}

function resolveRequestedModel(registry: ModelRegistry, requested: string) {
    const separator = requested.indexOf('/')
    if (separator > 0) {
        const provider = requested.slice(0, separator)
        const modelId = requested.slice(separator + 1)
        const model = registry.find(provider, modelId)
        if (model) return model
    } else {
        const matches = registry
            .getAll()
            .filter((model) => model.id === requested)
        if (matches.length === 1) return matches[0]
    }
    throw new Error(
        `Unknown or ambiguous model "${requested}": use provider/model-id`
    )
}

/**
 * True for our own extension entry. Children must not boot a second
 * subagents manager: collaboration arrives via customTools bound to the
 * root manager, and a duplicate registration would collide by tool name.
 */
export function isSubagentsExtensionPath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/')
    return (
        normalized.includes('/extensions/subagents/index.ts') ||
        normalized.endsWith('extensions/subagents/index.ts')
    )
}

/** Strip our own extension, keep everything else (fff, todowrite, ...). */
export function filterSubagentsExtension<
    T extends Pick<Extension, 'path' | 'resolvedPath'>,
>(extensions: readonly T[]): T[] {
    return extensions.filter(
        (ext) => !isSubagentsExtensionPath(ext.resolvedPath ?? ext.path ?? '')
    )
}

function minimalChildTools(): boolean {
    return process.env.SUBAGENTS_MINIMAL_CHILD_TOOLS === '1'
}

/**
 * Resource loader for child sessions: the full extension set minus
 * ourselves, honoring the user's settings (disabled extensions stay
 * disabled). Falls back to the extension-free loader if the full
 * reload fails, so a broken extension can never break spawning.
 * Never returns null: omitting the loader would make the SDK build its
 * own default, which loads everything including a second subagents copy.
 */
async function createChildResourceLoader(cwd: string) {
    if (!minimalChildTools()) {
        try {
            const loader = new DefaultResourceLoader({
                cwd,
                agentDir: getAgentDir(),
                settingsManager: SettingsManager.create(cwd, getAgentDir()),
                noSkills: true,
                noThemes: true,
                extensionsOverride: (
                    base: LoadExtensionsResult
                ): LoadExtensionsResult => ({
                    ...base,
                    extensions: filterSubagentsExtension(base.extensions),
                }),
            })
            await loader.reload()
            return loader
        } catch (error) {
            console.error(
                'subagents: full child extension load failed, falling back to minimal tools:',
                error instanceof Error ? error.message : String(error)
            )
        }
    }
    const minimal = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noThemes: true,
    })
    await minimal.reload()
    return minimal
}

/** Count named tool calls on a child branch (for the Tools panel). */
function namedToolCalls(
    entry: LiveSession
): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>()
    let entries: readonly unknown[] = []
    try {
        entries = entry.session.sessionManager.getEntries()
    } catch {
        return []
    }
    for (const item of entries) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        if (record.type !== 'message' || !isRecord(record.message)) continue
        const message = record.message
        if (message.role !== 'assistant' || !Array.isArray(message.content)) {
            continue
        }
        for (const block of message.content) {
            if (
                !isRecord(block) ||
                block.type !== 'toolCall' ||
                typeof block.name !== 'string'
            ) {
                continue
            }
            counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
        }
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => left.name.localeCompare(right.name))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** Create the SDK-backed host. */
export function createPiHostLive(args: {
    manager: () => SubagentManager
    getCwd: () => string
    getModel: () => { provider: string; id: string }
    getModelRegistry: () => ModelRegistry
}): PiHost {
    const live = new Map<string, LiveSession>()
    let counter = 0

    return {
        async getCwd(): Promise<string> {
            try {
                return args.getCwd()
            } catch {
                return process.cwd()
            }
        },
        async getModel() {
            // Model snapshot comes from the extension context at call time;
            // fall back to a stable marker when unavailable (print/RPC modes).
            try {
                const snapshot = args.getModel?.()
                if (snapshot) return snapshot
            } catch {
                // Best-effort only.
            }
            return { provider: 'pi', id: 'pi-default' }
        },
        async createSession(options: {
            agentPath: AgentPath
            fork: ForkTurns
            parentHistory: readonly string[]
            model?: string
            reasoningEffort?: string
            role?: string
        }): Promise<HostSessionHandle> {
            counter += 1
            const cwd = await this.getCwd()
            const forkMessages = selectForkHistory(
                options.parentHistory,
                options.fork
            )
            const sessionManager = SessionManager.inMemory(cwd)
            const childTools = buildChildToolDefinitions(
                args.manager() as never,
                options.agentPath
            )
            // Children load the full extension set (fff, todowrite, ...) so
            // they work with the same tools as the main session. Our own
            // extension is stripped by filterSubagentsExtension: the root
            // manager owns the tree and collaboration arrives via
            // customTools, so a second manager would only collide.
            const resourceLoader = await createChildResourceLoader(cwd)
            const model = options.model
                ? resolveRequestedModel(args.getModelRegistry(), options.model)
                : undefined
            const thinkingLevel = parseThinkingLevel(options.reasoningEffort)
            const { session } = await createAgentSession({
                cwd,
                sessionManager,
                resourceLoader,
                customTools: childTools as never,
                model,
                thinkingLevel,
            })
            // SDK sessions only activate the base four by default; the
            // registry holds everything else inactive (including our
            // collaboration tools, which breaks recursion). Activate all.
            try {
                session.setActiveToolsByName(
                    session.getAllTools().map((tool) => tool.name)
                )
            } catch {
                // A child with only base tools still runs.
            }
            const handle: LiveSession = {
                handleId: `live-${counter}`,
                persistedId: session.sessionId,
                forkMessages,
                session,
            }
            // Seed forked history as one baseline prompt so the child starts
            // with the requested parent context without extra turns.
            if (forkMessages.length > 0) {
                await session.prompt(
                    `Context from parent (history fork ${options.fork._tag}):\n\n${forkMessages.join('\n\n---\n\n')}`,
                    { expandPromptTemplates: false }
                )
            }
            live.set(handle.handleId, handle)
            try {
                args.manager().bindSession(session.sessionId, options.agentPath)
            } catch {
                // Binding is best-effort; tools default to /root.
            }
            return handle
        },
        async runTurn(
            session: HostSessionHandle,
            input: string,
            signal: AbortSignal
        ): Promise<{ lastMessage: string | null }> {
            const entry = live.get(session.handleId)
            if (!entry)
                throw new Error(`unknown live session ${session.handleId}`)
            if (signal.aborted) throw new Error('Aborted')
            const abort = () => {
                void entry.session.abort()
            }
            signal.addEventListener('abort', abort, { once: true })
            try {
                await entry.session.prompt(input, {
                    expandPromptTemplates: false,
                })
            } finally {
                signal.removeEventListener('abort', abort)
            }
            if (signal.aborted) throw new Error('Aborted')
            return { lastMessage: entry.session.getLastAssistantText() ?? null }
        },
        async interruptTurn(session: HostSessionHandle): Promise<void> {
            const entry = live.get(session.handleId)
            if (!entry) return
            await entry.session.abort()
        },
        async getUsage(session: HostSessionHandle): Promise<SessionUsage> {
            const entry = live.get(session.handleId)
            if (!entry) return emptySessionUsage()
            try {
                const stats = entry.session.getSessionStats()
                const model = entry.session.model
                const toolCalls = namedToolCalls(entry)
                return {
                    provider: model?.provider ?? 'pi',
                    modelId: model?.id ?? 'pi-default',
                    input: stats.tokens.input,
                    output: stats.tokens.output,
                    cacheRead: stats.tokens.cacheRead,
                    cacheWrite: stats.tokens.cacheWrite,
                    cost: stats.cost,
                    userMessages: stats.userMessages,
                    assistantMessages: stats.assistantMessages,
                    toolResults: stats.toolResults,
                    toolCalls,
                }
            } catch {
                return emptySessionUsage()
            }
        },
        async closeSession(session: HostSessionHandle): Promise<void> {
            const entry = live.get(session.handleId)
            if (!entry) return
            try {
                await entry.session.abort()
            } catch {
                // Best-effort teardown.
            }
            entry.session.dispose()
            live.delete(session.handleId)
        },
        async appendMessage(
            session: HostSessionHandle,
            text: string
        ): Promise<void> {
            const entry = live.get(session.handleId)
            if (!entry) return
            await entry.session.sendCustomMessage(
                {
                    customType: 'subagents-v2-message',
                    content: text,
                    display: false,
                    details: { origin: 'subagents-v2' },
                },
                { triggerTurn: false }
            )
        },
    }
}
