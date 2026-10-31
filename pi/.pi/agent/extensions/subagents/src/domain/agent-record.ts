/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/core/src/agent/control.rs (logical registry portion)
 *
 * Logical record only. Never store Fibers, Scopes, Deferreds, or
 * session handles here; those live in the runtime store.
 */

import type { ModelUsage } from '../../../shared/usage.ts'
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

export type AgentTaskKind = 'spawn' | 'followup'
export type AgentTaskStatus = 'active' | 'completed' | 'failed' | 'archived'

/** One submission and its correlation to a native child run. */
export interface AgentTask {
    readonly id: string
    readonly agentPath: AgentPath
    readonly objective: string
    readonly kind: AgentTaskKind
    readonly submittedBy: AgentPath
    readonly communicationId: string
    readonly runSequence?: number
    readonly status: AgentTaskStatus
    readonly createdAt: number
    readonly completedAt?: number
    readonly resultRef?: string
}

/** A saved identity that cannot be reopened under current host state. */
export interface AgentBlockedInfo {
    readonly code: string
    readonly reason: string
}

/** A run terminated by a configured execution limit. */
export interface AgentLimitReached {
    readonly kind: 'deadline' | 'requests' | 'tokens'
    readonly detail: string
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
    /** Present only when the last run terminated by a configured limit. */
    readonly limitReached?: AgentLimitReached
    /** Present when a cold reopen failed for a stable, actionable reason. */
    readonly blocked?: AgentBlockedInfo
    /** Terminal identities stop counting against the logical quota. */
    readonly archivedAt?: number
    readonly lastResult?: string
    readonly initiatingTurnId?: string
    /** Initial spawn prompt (the NEW_TASK payload) for UI display. */
    readonly task?: string
    /** Accumulated usage across all turns/sessions of this agent. */
    readonly usage?: AgentUsageTotals
}
