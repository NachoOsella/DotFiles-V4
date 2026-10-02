/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/core/src/agent/control.rs (logical registry portion)
 *
 * Logical record only. Never store Fibers, Scopes, Deferreds, or
 * session handles here; those live in the runtime store.
 */

import type { ModelUsage } from '../../../session-stats/types.ts'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { FinalAnswerMeta } from './communication.ts'
import type { AgentId, AgentPath, CommunicationId } from './ids.ts'
import type { AgentResidency, AgentStatus } from './agent-status.ts'

export interface PendingCompletion {
    readonly communicationId: CommunicationId
    readonly runSequence: number
    readonly author: AgentPath
    readonly recipient: AgentPath
    readonly payload: string
    readonly meta?: FinalAnswerMeta
}

/** Tool call count by name, for the inspector's top-tools row. */
export interface SessionToolCallCount {
    readonly name: string
    readonly count: number
}

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
    /** Per-request pricing accumulated by physical provider/model. */
    readonly models?: readonly ModelUsage[]
}

/** Logical identity and accumulated diagnostics, separate from a live session. */
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
    readonly sessionId?: string
    readonly sessionFile?: string
    readonly rootSessionId?: string
    readonly cwd?: string
    readonly activeTools?: readonly string[]
    readonly thinkingLevel?: ThinkingLevel
    readonly runSequence?: number
    /** Runtime-only start of the current run; never serialized. */
    readonly runStartedAt?: number
    readonly lastDeliveredRunSequence?: number
    readonly pendingCompletions?: readonly PendingCompletion[]
    readonly lastResult?: string
    readonly initiatingTurnId?: string
    /** Initial spawn prompt (the NEW_TASK payload) for UI display. */
    readonly task?: string
    /** Accumulated usage across all turns/sessions of this agent. */
    readonly usage?: AgentUsageTotals
}
