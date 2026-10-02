/**
 * Read-only projection for the native subagent inspector.
 *
 * The projection is derived from committed host state: the session-scoped
 * registry document, the native task graph, and each conversation's `pi.usage`.
 * It carries no lifecycle authority and is safe to render from any subscriber.
 */

import type {
    ConversationId,
    LiveState,
    TaskGraph,
    UsageState,
} from '@earendil-works/pi-durable'
import type { Usage } from '@earendil-works/pi-ai'
import { WAIT_AGENT_TOOL } from '../tools/index.js'
import type { OwnGenerationStatus } from '../runtime/status.js'

export type AgentStatus =
    | 'idle'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'errored'
    | 'interrupted'
    | 'unknown'

/** One child's identity and last known presentation state. */
export interface AgentSummary {
    readonly path: string
    readonly name: string
    readonly parentPath: string | null
    readonly role?: string
    readonly model?: string
    readonly thinkingLevel?: string
    readonly status: AgentStatus
    readonly conversationId: ConversationId
    readonly createdAt: number
    readonly updatedAt?: number
    readonly usage?: UsageState
    readonly lastAnswer?: string
}

/** Input rows the host reads from the registry document and native agent docs. */
export interface ProjectedAgentInput {
    readonly path: string
    readonly name: string
    readonly parentPath: string | null
    readonly role?: string
    readonly conversationId: ConversationId
    readonly createdAt: number
    readonly updatedAt?: number
    readonly model?: string
    readonly thinkingLevel?: string
    readonly lastAnswer?: string
    /** Explicit override; otherwise derived from live state and the terminal receipt. */
    readonly status?: AgentStatus
}

export interface SubagentProjection {
    readonly generatedAt: number
    readonly agents: readonly AgentSummary[]
    readonly taskGraph: TaskGraph
    readonly counts: {
        readonly total: number
        readonly running: number
        readonly waiting: number
    }
}

export interface AgentTree {
    readonly agent: AgentSummary
    readonly children: readonly AgentTree[]
}

/** Read side of a native projection, with optional per-child activity. */
export interface SubagentProjectionSource {
    read(): SubagentProjection
    subscribe(listener: (projection: SubagentProjection) => void): () => void
    activity?(conversationId: ConversationId): Promise<readonly string[]>
    watchActivity?(
        conversationId: ConversationId,
        listener: (lines: readonly string[]) => void
    ): () => void
}

export function emptyProjection(now = Date.now()): SubagentProjection {
    return {
        generatedAt: now,
        agents: [],
        taskGraph: { tasks: {} },
        counts: { total: 0, running: 0, waiting: 0 },
    }
}

/** Build the projection from already-read host state; performs no I/O. */
export function toProjection(
    inputs: readonly ProjectedAgentInput[],
    taskGraph: TaskGraph,
    liveByConversation: ReadonlyMap<ConversationId, LiveState>,
    terminalByConversation: ReadonlyMap<ConversationId, OwnGenerationStatus>,
    usageByConversation: ReadonlyMap<ConversationId, UsageState>,
    now = Date.now()
): SubagentProjection {
    const agents = inputs
        .map((input): AgentSummary => {
            const usage = usageByConversation.get(input.conversationId)
            const status =
                input.status ??
                statusFromLive(
                    liveByConversation.get(input.conversationId),
                    terminalByConversation.get(input.conversationId)
                )
            return {
                path: input.path,
                name: input.name,
                parentPath: input.parentPath,
                ...(input.role === undefined ? {} : { role: input.role }),
                ...(input.model === undefined ? {} : { model: input.model }),
                ...(input.thinkingLevel === undefined
                    ? {}
                    : { thinkingLevel: input.thinkingLevel }),
                status,
                conversationId: input.conversationId,
                createdAt: input.createdAt,
                ...(input.updatedAt === undefined
                    ? {}
                    : { updatedAt: input.updatedAt }),
                ...(usage === undefined ? {} : { usage }),
                ...(input.lastAnswer === undefined
                    ? {}
                    : { lastAnswer: input.lastAnswer }),
            }
        })
        .sort((a, b) => a.path.localeCompare(b.path))
    let running = 0
    let waiting = 0
    for (const agent of agents) {
        if (agent.status === 'running') running += 1
        else if (agent.status === 'waiting') waiting += 1
    }
    return {
        generatedAt: now,
        agents,
        taskGraph,
        counts: { total: agents.length, running, waiting },
    }
}

/**
 * A child is running while its own `pi.live.run` is present; a run blocked in a
 * `wait_agent` call is waiting. With no run, the newest assistant stop reason
 * keeps the last terminal state instead of falling back to idle after its tasks
 * leave the graph.
 */
export function statusFromLive(
    live: LiveState | undefined,
    terminal?: OwnGenerationStatus
): AgentStatus {
    if (live?.run !== undefined) {
        const waiting = (live.tools ?? []).some(
            (slot) => slot.status === 'running' && slot.name === WAIT_AGENT_TOOL
        )
        return waiting ? 'waiting' : 'running'
    }
    switch (terminal) {
        case 'Completed':
            return 'completed'
        case 'Errored':
            return 'errored'
        case 'Interrupted':
            return 'interrupted'
        default:
            return 'idle'
    }
}

/** Nest agents by `parentPath`; orphans are roots so a partial registry still renders. */
export function agentTree(
    agents: readonly AgentSummary[]
): readonly AgentTree[] {
    const byPath = new Map(agents.map((agent) => [agent.path, agent]))
    const childrenOf = new Map<string | null, AgentSummary[]>()
    for (const agent of agents) {
        const parent =
            agent.parentPath !== null && byPath.has(agent.parentPath)
                ? agent.parentPath
                : null
        const siblings = childrenOf.get(parent)
        if (siblings === undefined) childrenOf.set(parent, [agent])
        else siblings.push(agent)
    }
    const build = (parent: string | null): AgentTree[] =>
        (childrenOf.get(parent) ?? [])
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((agent) => ({ agent, children: build(agent.path) }))
    return build(null)
}

/** Total tokens across model and tool buckets. */
export function totalTokens(usage: UsageState | undefined): number {
    if (usage === undefined) return 0
    let total = 0
    for (const bucket of [usage.models, usage.tools]) {
        for (const value of Object.values(bucket))
            total += (value as Usage).totalTokens
    }
    return total
}

/** Total cost across model and tool buckets. */
export function totalCost(usage: UsageState | undefined): number {
    if (usage === undefined) return 0
    let total = 0
    for (const bucket of [usage.models, usage.tools]) {
        for (const value of Object.values(bucket))
            total += (value as Usage).cost.total
    }
    return total
}

/** Compact `1.2k` / `3.4M` token counts for narrow rows. */
export function formatTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens)
    if (tokens < 1_000_000)
        return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
    return `${(tokens / 1_000_000).toFixed(1)}M`
}
