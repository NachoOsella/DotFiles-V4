/**
 * Session registry and task-scoped operation receipts for the Durable-native
 * subagents extension.
 *
 * The registry maps canonical agent paths to logical identity metadata only.
 * `/root` is the reserved Durable root conversation and is never stored here;
 * running state, queues, transcripts, usage, and ownership stay in Durable.
 *
 * The operation receipt is small workflow state committed together with the
 * child conversation and reporter task it describes, so a replay-safe spawn
 * tool can distinguish a replay of the same call from a different call that
 * targets the same name.
 */

import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'

/** Logical identity of one registered child agent. */
export type AgentMetadata = {
    /** Last path segment, the task name used at creation. */
    readonly name: string
    /** Canonical `/root/...` path; the registry key. */
    readonly path: string
    /** Canonical direct-parent path. */
    readonly parentPath: string
    /** Child conversation that owns this identity. */
    readonly conversationId: ConversationId
    /** Configured agent type, when one was selected. */
    readonly role?: string
    /** Creation time from the host clock. */
    readonly createdAt: number
}

/** Session-scoped registry of logical agent identities, keyed by canonical path. */
export type SubagentsState = {
    readonly agents: Record<string, AgentMetadata>
}

/** Session document holding every non-root logical agent identity. */
export const SubagentsDoc = defineDoc<SubagentsState>({
    kind: 'subagents.state',
    version: 1,
    scope: 'session',
    initial: () => ({ agents: {} }),
})

export type SpawnReceiptDetails = {
    readonly task_name: string
    readonly agent_type?: string
    readonly model?: string
    readonly thinking_level?: string
    readonly fork_turns?: string
}

/**
 * Task-scoped receipt for one spawn operation. Committed in the same commit
 * that creates the child conversation, the anchor task, and the reporter, so a
 * replay finds it before deciding whether to create anything.
 */
export type OperationReceipt = {
    /** Child conversation created by this operation. */
    readonly conversationId?: ConversationId
    /** Background reporter task that delivers the initial NEW_TASK. */
    readonly reporterId?: TaskId
    /** Tool response decided with creation, unchanged by later role/config updates. */
    readonly spawnResult?: SpawnReceiptDetails
}

/** Task document describing what one replay-safe spawn call already created. */
export const OperationReceiptDoc = defineDoc<OperationReceipt>({
    kind: 'subagents.operation-receipt',
    version: 1,
    scope: 'task',
    initial: () => ({}),
})

/** Read one registry entry without throwing on an absent or malformed value. */
export function getAgentMetadata(
    state: SubagentsState | undefined,
    path: string
): AgentMetadata | undefined {
    return state?.agents[path]
}

/** Number of registered non-root logical agents. */
export function agentCount(state: SubagentsState | undefined): number {
    return state === undefined ? 0 : Object.keys(state.agents).length
}
