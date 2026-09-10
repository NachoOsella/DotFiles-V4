/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/core/src/agent/control.rs (logical registry portion)
 *
 * Logical record only. Never store Fibers, Scopes, Deferreds, or
 * session handles here; those live in the runtime store.
 */

import type { SessionToolCallCount } from './host.ts'
import type { AgentId, AgentPath } from './ids.ts'
import type { AgentResidency, AgentStatus } from './agent-status.ts'

/** Accumulated usage totals for one logical agent (plain data). */
export interface AgentUsageTotals {
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
    readonly toolCalls: ReadonlyArray<SessionToolCallCount>
}

/** Add one turn delta into accumulated totals (identity from latest). */
export function addUsageDelta(
    totals: AgentUsageTotals | undefined,
    delta: AgentUsageTotals
): AgentUsageTotals {
    if (!totals) return delta
    const counts = new Map<string, number>()
    for (const entry of totals.toolCalls) counts.set(entry.name, entry.count)
    for (const entry of delta.toolCalls) {
        counts.set(entry.name, (counts.get(entry.name) ?? 0) + entry.count)
    }
    const toolCalls = [...counts.entries()]
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => left.name.localeCompare(right.name))
    return {
        provider: delta.provider,
        modelId: delta.modelId,
        input: totals.input + delta.input,
        output: totals.output + delta.output,
        cacheRead: totals.cacheRead + delta.cacheRead,
        cacheWrite: totals.cacheWrite + delta.cacheWrite,
        cost: totals.cost + delta.cost,
        userMessages: totals.userMessages + delta.userMessages,
        assistantMessages: totals.assistantMessages + delta.assistantMessages,
        toolResults: totals.toolResults + delta.toolResults,
        toolCalls,
    }
}

export interface AgentRecord {
    readonly id: AgentId
    readonly path: AgentPath
    readonly parentId: AgentId | null
    readonly parentPath: AgentPath | null
    readonly status: AgentStatus
    readonly residency: AgentResidency
    readonly role?: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly createdAt: number
    readonly lastActivityAt: number
    readonly persistedSessionId?: string
    readonly initiatingTurnId?: string
    /** Fork policy snapshot for reload/diagnostics. */
    readonly forkKind?: string
    /** Accumulated usage across all turns/sessions of this agent. */
    readonly usage?: AgentUsageTotals
}

export interface AgentRecordInit {
    readonly id: AgentId
    readonly path: AgentPath
    readonly parentId: AgentId | null
    readonly parentPath: AgentPath | null
    readonly role?: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly persistedSessionId?: string
    readonly initiatingTurnId?: string
    readonly forkKind?: string
}
