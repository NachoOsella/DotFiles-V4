/** Branded identity types for the subagent runtime. */

export type AgentId = string & { readonly __brand: 'AgentId' }
export type AgentPath = string & { readonly __brand: 'AgentPath' }
export type TurnId = string & { readonly __brand: 'TurnId' }
export type ToolCallId = string & { readonly __brand: 'ToolCallId' }
export type CommunicationId = string & { readonly __brand: 'CommunicationId' }

let counter = 0

/** Generate a unique agent id (hex, no external dependency). */
export function newAgentId(): AgentId {
    counter += 1
    const rand = Math.floor(Math.random() * 0xffffffff).toString(16)
    return `agent-${Date.now().toString(36)}-${counter.toString(36)}-${rand}` as AgentId
}

/** Generate a unique communication id. */
export function newCommunicationId(): CommunicationId {
    counter += 1
    const rand = Math.floor(Math.random() * 0xffffffff).toString(16)
    return `comm-${Date.now().toString(36)}-${counter.toString(36)}-${rand}` as CommunicationId
}

/** Generate a unique turn id. */
export function newTurnId(): TurnId {
    counter += 1
    const rand = Math.floor(Math.random() * 0xffffffff).toString(16)
    return `turn-${Date.now().toString(36)}-${counter.toString(36)}-${rand}` as TurnId
}
