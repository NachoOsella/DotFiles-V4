/**
 * New-methodology subagent usage for session-stats.
 *
 * Subagent children run in memory-only SDK sessions that never touch disk,
 * so file discovery cannot see them. The subagents extension instead records
 * per-agent accumulated usage in its `subagents-v2-state` snapshot (a plain
 * CustomEntry persisted on the parent branch). This module reads the latest
 * snapshot and converts each agent with usage into SessionStats that merge
 * with the existing pipeline (per-agent breakdown + Threads panel).
 *
 * Legacy file-based children (parentSessionPath links, `subagent:` names)
 * keep working through the unchanged discovery path in index.ts.
 */

import {
    findLatestState,
    isPersistedState,
} from '../subagents/src/persistence.ts'
import type { PersistedMultiAgentState } from '../subagents/src/manager.ts'
import { finalizeTotalTokens } from './format.ts'
import { calculateUsageCost, combinePricingSources } from './pricing.ts'
import type {
    ModelPricingResolver,
    ModelUsage,
    PricingSource,
    SessionStats,
    ToolUsage,
} from './types.ts'

interface ValidatedAgentUsage {
    readonly provider: string
    readonly modelId: string
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly cost: number
    readonly userMessages: number
    readonly assistantMessages: number
    readonly toolResults: number
    readonly toolCalls: ToolUsage[]
}

/** Build per-agent stats from the latest snapshot on a branch. */
export function buildSubagentSnapshotStats(
    entries: readonly unknown[],
    file: string,
    pricing?: ModelPricingResolver
): SessionStats[] {
    const snapshot = findLatestState(entries)
    if (!snapshot) return []
    return buildStatsFromSnapshotData(snapshot, file, pricing)
}

/** Wall-clock age of the latest snapshot in ms, if present. */
export function getSubagentSnapshotAge(
    entries: readonly unknown[]
): number | undefined {
    const snapshot = findLatestState(entries)
    const persistedAt =
        snapshot &&
        typeof (snapshot as { persistedAt?: unknown }).persistedAt === 'number'
            ? ((snapshot as { persistedAt: number }).persistedAt as number)
            : undefined
    if (
        persistedAt === undefined ||
        !Number.isFinite(persistedAt) ||
        persistedAt <= 0
    ) {
        return undefined
    }
    return Math.max(0, Date.now() - persistedAt)
}

/** Build per-agent stats from one snapshot object (pure, testable). */
export function buildStatsFromSnapshotData(
    data: unknown,
    file: string,
    pricing?: ModelPricingResolver
): SessionStats[] {
    if (!isPersistedState(data)) return []
    return snapshotAgents(data).flatMap((agent) =>
        agentStats(agent, file, pricing)
    )
}

function snapshotAgents(
    snapshot: PersistedMultiAgentState
): Array<Record<string, unknown>> {
    const agents: Array<Record<string, unknown>> = []
    for (const agent of snapshot.agents) {
        if (isRecord(agent)) agents.push(agent)
    }
    return agents
}

function agentStats(
    agent: Record<string, unknown>,
    file: string,
    pricing?: ModelPricingResolver
): SessionStats[] {
    const usage = readUsage(agent)
    if (!usage) return []
    const path = typeof agent.path === 'string' ? agent.path : 'subagent'
    const tokenCount =
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    const classified = classifySnapshotCost(usage, tokenCount, pricing)
    const model: ModelUsage = {
        provider: usage.provider,
        modelId: usage.modelId,
        count: usage.assistantMessages,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: classified.actual,
        reportedCost: classified.reported,
        catalogCost: classified.catalog,
        estimatedCost: classified.estimated,
        unknownTokens: classified.unknownTokens,
        pricedTokens: classified.pricedTokens,
        pricingSource: classified.source,
    }
    const stats: SessionStats = {
        file,
        name: path,
        parentSessionPath: file,
        totalTokens: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: tokenCount,
            cost: {
                total: classified.actual,
                reported: classified.reported,
                catalog: classified.catalog,
                estimated: classified.estimated,
                unknownTokens: classified.unknownTokens,
                pricedTokens: classified.pricedTokens,
            },
        },
        userMessages: usage.userMessages,
        assistantMessages: usage.assistantMessages,
        toolResults: usage.toolResults,
        toolCalls: usage.toolCalls,
        models: [model],
        customMessages: 0,
    }
    const createdAt = readTime(agent.createdAt)
    const lastActivityAt = readTime(agent.lastActivityAt)
    if (createdAt !== undefined) {
        stats.startTime = new Date(createdAt).toISOString()
    }
    if (createdAt !== undefined && lastActivityAt !== undefined) {
        stats.durationMs = Math.max(0, lastActivityAt - createdAt)
    }
    finalizeTotalTokens(stats)
    return [stats]
}

/** Extract and sanitize one agent's usage; undefined when absent or empty. */
function readUsage(
    agent: Record<string, unknown>
): ValidatedAgentUsage | undefined {
    const fallbackModel =
        typeof agent.model === 'string' ? agent.model : undefined
    // Agents that never ran a turn carry no usage yet.
    if (!isRecord(agent.usage)) return undefined
    const usage = agent.usage
    const input = readTokens(usage.input)
    const output = readTokens(usage.output)
    const cacheRead = readTokens(usage.cacheRead)
    const cacheWrite = readTokens(usage.cacheWrite)
    const cost = readTokens(usage.cost)
    const userMessages = readCount(usage.userMessages)
    const assistantMessages = readCount(usage.assistantMessages)
    const toolResults = readCount(usage.toolResults)
    if (
        input + output + cacheRead + cacheWrite + cost === 0 &&
        userMessages + assistantMessages + toolResults === 0
    ) {
        return undefined
    }
    return {
        provider: typeof usage.provider === 'string' ? usage.provider : '',
        modelId:
            typeof usage.modelId === 'string'
                ? usage.modelId
                : (fallbackModel ?? 'unknown'),
        input,
        output,
        cacheRead,
        cacheWrite,
        cost,
        userMessages,
        assistantMessages,
        toolResults,
        toolCalls: readToolCalls(usage.toolCalls),
    }
}

function readToolCalls(value: unknown): ToolUsage[] {
    if (!Array.isArray(value)) return []
    const counts = new Map<string, number>()
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.name !== 'string') continue
        const count = readCount(entry.count)
        if (count === 0) continue
        counts.set(entry.name, (counts.get(entry.name) ?? 0) + count)
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort(
            (left, right) =>
                right.count - left.count || left.name.localeCompare(right.name)
        )
}

interface ClassifiedCost {
    readonly actual: number
    readonly reported: number
    readonly catalog: number
    readonly estimated: number
    readonly unknownTokens: number
    readonly pricedTokens: number
    readonly source: PricingSource | undefined
}

/**
 * Mirror the parser's cost precedence: provider-reported cost first, then
 * catalog calculation, then unknown. Free-model reference estimates flow
 * through the shared resolver.
 */
function classifySnapshotCost(
    usage: ValidatedAgentUsage,
    tokenCount: number,
    pricingResolver?: ModelPricingResolver
): ClassifiedCost {
    if (usage.cost > 0) {
        return {
            actual: usage.cost,
            reported: usage.cost,
            catalog: 0,
            estimated: 0,
            unknownTokens: 0,
            pricedTokens: tokenCount,
            source: 'reported',
        }
    }
    const pricing =
        usage.provider && usage.modelId
            ? pricingResolver?.(usage.provider, usage.modelId)
            : undefined
    if (pricing) {
        const calculated = calculateUsageCost(
            {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
            },
            pricing
        )
        if (pricing.source === 'estimated') {
            return {
                actual: 0,
                reported: 0,
                catalog: 0,
                estimated: calculated,
                unknownTokens: 0,
                pricedTokens: tokenCount,
                source: 'estimated',
            }
        }
        return {
            actual: calculated,
            reported: 0,
            catalog: calculated,
            estimated: 0,
            unknownTokens: 0,
            pricedTokens: tokenCount,
            source: 'catalog',
        }
    }
    return {
        actual: 0,
        reported: 0,
        catalog: 0,
        estimated: 0,
        unknownTokens: tokenCount,
        pricedTokens: 0,
        source: tokenCount > 0 ? 'unknown' : undefined,
    }
}

function readTokens(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0
}

function readCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0
    }
    return Math.floor(value)
}

function readTime(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}
