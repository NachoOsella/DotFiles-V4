/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs (fork parsing)
 * codex-rs/core/src/agent_communication.rs (kind/context)
 * codex-rs/protocol/src/protocol.rs (InterAgentCommunication)
 *
 * Three model-visible types: NEW_TASK, MESSAGE, FINAL_ANSWER.
 */

import type { AgentPath, CommunicationId, ToolCallId, TurnId } from './ids.ts'
import { newCommunicationId } from './ids.ts'

export type InterAgentMessageType = 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER'

export type CommunicationKind = 'spawn' | 'message' | 'followup' | 'result'

export interface InterAgentCommunication {
    readonly id: CommunicationId
    readonly kind: CommunicationKind
    readonly messageType: InterAgentMessageType
    readonly author: AgentPath
    readonly recipient: AgentPath
    readonly payload: string
    readonly triggerTurn: boolean
    readonly sourceCallId?: ToolCallId
    readonly initiatingTurnId?: TurnId
}

export type ForkTurns =
    | { readonly _tag: 'None' }
    | { readonly _tag: 'All' }
    | { readonly _tag: 'LastN'; readonly turns: number }

export class InvalidForkTurnsError extends Error {
    readonly _tag = 'InvalidForkTurns'
    readonly value: string
    constructor(value: string) {
        super(
            `Invalid fork_turns "${value}": use "all", "none", or a positive integer N.`
        )
        this.name = 'InvalidForkTurnsError'
        this.value = value
    }
}

export class EmptyAgentMessageError extends Error {
    readonly _tag = 'EmptyAgentMessage'
    constructor() {
        super('Message must not be empty.')
        this.name = 'EmptyAgentMessageError'
    }
}

/**
 * Parse fork_turns exactly:
 * omitted/blank -> all, "all" -> full history, "none" -> fresh,
 * "N" (N>0) -> last N turns, anything else -> validation failure.
 * "0" is invalid.
 */
export function parseForkTurns(value: string | undefined): ForkTurns {
    if (value === undefined) return { _tag: 'All' }
    const trimmed = value.trim()
    if (trimmed === '') return { _tag: 'All' }
    const lowered = trimmed.toLowerCase()
    if (lowered === 'all') return { _tag: 'All' }
    if (lowered === 'none') return { _tag: 'None' }
    if (/^\d+$/.test(trimmed)) {
        const n = Number.parseInt(trimmed, 10)
        if (!Number.isSafeInteger(n) || n <= 0) {
            throw new InvalidForkTurnsError(value)
        }
        return { _tag: 'LastN', turns: n }
    }
    throw new InvalidForkTurnsError(value)
}

/** Reject empty/whitespace-only payloads shared by send/followup/spawn. */
export function assertNonEmptyMessage(message: string): void {
    if (message.trim().length === 0) throw new EmptyAgentMessageError()
}

/** Canonical model-visible envelope shared by all V2 communication. */
export function renderEnvelope(
    messageType: InterAgentMessageType,
    recipientName: string,
    sender: string,
    payload: string
): string {
    return [
        `Message Type: ${messageType}`,
        `Task name: ${recipientName}`,
        `Sender: ${sender}`,
        'Payload:',
        payload,
    ].join('\n')
}

/** Short display name for envelope headers (last path segment). */
export function displayNameFor(path: AgentPath): string {
    if (path === ('/root' as AgentPath)) return '/root'
    const idx = path.lastIndexOf('/')
    return path.slice(idx + 1)
}

function makeCommunication(args: {
    kind: CommunicationKind
    messageType: InterAgentMessageType
    author: AgentPath
    recipient: AgentPath
    payload: string
    triggerTurn: boolean
    sourceCallId?: ToolCallId
    initiatingTurnId?: TurnId
}): InterAgentCommunication {
    return {
        id: newCommunicationId(),
        kind: args.kind,
        messageType: args.messageType,
        author: args.author,
        recipient: args.recipient,
        payload: args.payload,
        triggerTurn: args.triggerTurn,
        sourceCallId: args.sourceCallId,
        initiatingTurnId: args.initiatingTurnId,
    }
}

/** spawn_agent and followup_task produce NEW_TASK + triggerTurn. */
export function newTaskCommunication(args: {
    kind: 'spawn' | 'followup'
    author: AgentPath
    recipient: AgentPath
    payload: string
    sourceCallId?: ToolCallId
    initiatingTurnId?: TurnId
}): InterAgentCommunication {
    assertNonEmptyMessage(args.payload)
    return makeCommunication({
        kind: args.kind,
        messageType: 'NEW_TASK',
        author: args.author,
        recipient: args.recipient,
        payload: args.payload,
        triggerTurn: true,
        sourceCallId: args.sourceCallId,
        initiatingTurnId: args.initiatingTurnId,
    })
}

/** send_message produces MESSAGE without triggering a turn. */
export function plainMessageCommunication(args: {
    author: AgentPath
    recipient: AgentPath
    payload: string
    sourceCallId?: ToolCallId
}): InterAgentCommunication {
    assertNonEmptyMessage(args.payload)
    return makeCommunication({
        kind: 'message',
        messageType: 'MESSAGE',
        author: args.author,
        recipient: args.recipient,
        payload: args.payload,
        triggerTurn: false,
        sourceCallId: args.sourceCallId,
    })
}

/** Terminal child results produce queue-only FINAL_ANSWER. */
export function finalAnswerCommunication(args: {
    author: AgentPath
    recipient: AgentPath
    payload: string
}): InterAgentCommunication {
    return makeCommunication({
        kind: 'result',
        messageType: 'FINAL_ANSWER',
        author: args.author,
        recipient: args.recipient,
        payload: args.payload,
        triggerTurn: false,
    })
}

/** Render the full model-visible text for one communication. */
export function renderCommunicationText(comm: InterAgentCommunication): string {
    return renderEnvelope(
        comm.messageType,
        displayNameFor(comm.recipient),
        comm.author,
        comm.payload
    )
}
