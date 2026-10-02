/**
 * Shared runtime helpers for the native subagents tools.
 *
 * Everything here reads committed Durable state. There is no coordinator,
 * mailbox, run registry, or lifecycle cache.
 */

import type { Context } from '@earendil-works/chord'
import type {
    ConversationId,
    ToolExecutionApi,
} from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { AgentPath } from '../domain/agent-path.js'
import { ROOT_PATH } from '../domain/agent-path.js'
import type { SubagentsConfig } from '../config/config.js'
import type { PassiveWriter } from '../extension.js'
import {
    getAgentMetadata,
    SubagentsDoc,
    type AgentMetadata,
    type SubagentsState,
} from '../state/subagents-doc.js'

export const SPAWN_AGENT_TOOL = 'spawn_agent'
export const SEND_MESSAGE_TOOL = 'send_message'
export const FOLLOWUP_TASK_TOOL = 'followup_task'
export const WAIT_AGENT_TOOL = 'wait_agent'
export const INTERRUPT_AGENT_TOOL = 'interrupt_agent'
export const LIST_AGENTS_TOOL = 'list_agents'

export const COLLABORATION_TOOL_NAMES: readonly string[] = [
    SPAWN_AGENT_TOOL,
    SEND_MESSAGE_TOOL,
    FOLLOWUP_TASK_TOOL,
    WAIT_AGENT_TOOL,
    INTERRUPT_AGENT_TOOL,
    LIST_AGENTS_TOOL,
]

/** Immutable dependencies shared by every tool registration. */
export interface RuntimeDeps {
    readonly config: SubagentsConfig
    readonly submitWrite: PassiveWriter
}

/** Caller identity resolved from the tool's conversation. */
export interface CallerInfo {
    readonly path: AgentPath
    readonly conversationId: ConversationId
    readonly role?: string
}

/** Look up the calling agent's canonical path. `/root` is implicit. */
export async function callerInfo(
    api: ToolExecutionApi,
    context: Context
): Promise<CallerInfo> {
    const conversationId = api.conversationId
    if (conversationId === ROOT_CONVERSATION_ID) {
        return { path: ROOT_PATH, conversationId }
    }
    const state = await api.snapshot(SubagentsDoc, context)
    const found = findAgentByConversation(state, conversationId)
    if (found === undefined) {
        throw new Error(
            `Conversation ${conversationId} is not a registered subagent conversation.`
        )
    }
    return {
        path: found.path,
        conversationId,
        ...(found.role === undefined ? {} : { role: found.role }),
    }
}

function findAgentByConversation(
    state: Readonly<SubagentsState> | undefined,
    conversationId: ConversationId
): AgentMetadata | undefined {
    if (state === undefined) return undefined
    return Object.values(state.agents).find(
        (agent) => agent.conversationId === conversationId
    )
}

/** Read one registered agent or throw. */
export async function requireAgent(
    api: ToolExecutionApi,
    context: Context,
    path: AgentPath
): Promise<AgentMetadata> {
    const state = await api.snapshot(SubagentsDoc, context)
    const found = getAgentMetadata(state, path)
    if (found === undefined) {
        throw new Error(`No subagent is registered at ${path}.`)
    }
    return found
}

/** Resolve the conversation for one canonical path; `/root` is implicit. */
export async function resolveConversationId(
    api: ToolExecutionApi,
    context: Context,
    path: AgentPath
): Promise<ConversationId> {
    if (path === ROOT_PATH) return ROOT_CONVERSATION_ID
    const agent = await requireAgent(api, context, path)
    return agent.conversationId
}
