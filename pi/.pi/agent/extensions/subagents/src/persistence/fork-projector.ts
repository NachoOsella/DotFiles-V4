import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { TextContent } from '@earendil-works/pi-ai'
import {
    buildSessionProjection,
    type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type { ForkTurns } from '../domain/communication.ts'

const COMMUNICATION_TYPES = new Set([
    'subagents-v3:communication',
    'subagents-v3-state',
])

/** Inherited inter-agent assignment, kept as context instead of a control envelope. */
export const INHERITED_TASK_CUSTOM_TYPE = 'subagents-v3:inherited-task'

/** Fallback representation for a branch summary with no child entry to anchor to. */
export const INHERITED_SUMMARY_CUSTOM_TYPE = 'subagents-v3:inherited-summary'

export interface ProjectForkOptions {
    /**
     * Keep prior inter-agent assignments as provenance-labelled inherited
     * context. The legacy message projection drops them to preserve its
     * existing output shape; child sessions enable this so a selected turn
     * still carries the task it answered.
     */
    readonly inheritedTaskContext?: boolean
}

/**
 * Project Pi's active structured context into a child conversation.
 *
 * Logical turns are grouped before communication payloads are filtered.
 * Filtering first would remove the `NEW_TASK` inputs that delimit real child
 * work, merging separate assignments into one turn.
 */
export function projectFork(
    entries: readonly SessionEntry[],
    fork: ForkTurns,
    options: ProjectForkOptions = {}
): AgentMessage[] {
    if (fork._tag === 'None') return []

    const projected = buildSessionProjection([...entries]).messages
    const turns = groupTurns(
        projected.filter((message) => !isBaseline(message))
    )
    const projectedTurns = turns.map((turn) =>
        turn.flatMap((message) => projectMessage(message, options))
    )
    const turnIndex = new Map<AgentMessage, number>()
    turns.forEach((turn, index) => {
        for (const message of turn) turnIndex.set(message, index)
    })
    const nonEmptyTurns = projectedTurns
        .map((messages, index) => ({ messages, index }))
        .filter((turn) => turn.messages.length > 0)
    const selected =
        fork._tag === 'All' ? nonEmptyTurns : nonEmptyTurns.slice(-fork.turns)
    const keptTurns = new Set(selected.map((turn) => turn.index))

    // Preserve the projection's original order so summaries stay at their
    // branch position instead of being hoisted above the messages they follow.
    return projected.flatMap((message) => {
        if (isBaseline(message)) return [message]
        const index = turnIndex.get(message)
        if (index === undefined || !keptTurns.has(index)) return []
        return projectMessage(message, options)
    })
}

function projectMessage(
    message: AgentMessage,
    options: ProjectForkOptions
): AgentMessage[] {
    if (message.role === 'toolResult' || message.role === 'bashExecution') {
        return []
    }
    if (message.role === 'assistant') {
        if (!isFinalAssistant(message)) return []
        const content = message.content.filter(
            (block): block is TextContent => block.type === 'text'
        )
        if (content.length === 0) return []
        // The parent already paid for this response. Retain its context, not
        // its billable usage, in the independent child session.
        return [
            {
                ...message,
                content,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
            },
        ]
    }
    if (
        message.role === 'custom' &&
        COMMUNICATION_TYPES.has(message.customType)
    ) {
        return options.inheritedTaskContext ? inheritedTask(message) : []
    }
    return [message]
}

function isBaseline(message: AgentMessage): boolean {
    return (
        message.role === 'system' ||
        message.role === 'compactionSummary' ||
        message.role === 'branchSummary'
    )
}

function isFinalAssistant(message: AgentMessage): boolean {
    if (message.role !== 'assistant') return false
    if (message.stopReason !== 'stop' && message.stopReason !== 'length') {
        return false
    }
    return message.content.some((block) => block.type === 'text')
}

/**
 * Group input plus its completed response into logical turns.
 *
 * Consecutive inputs stay in one turn until a retained assistant response
 * closes it, so steering and result notifications do not detach the answer
 * from the inputs it addressed.
 */
function groupTurns(messages: readonly AgentMessage[]): AgentMessage[][] {
    const turns: AgentMessage[][] = []
    let current: AgentMessage[] = []

    for (const message of messages) {
        const startsInput = message.role === 'user' || message.role === 'custom'
        if (
            startsInput &&
            current.length > 0 &&
            current.some(isFinalAssistant)
        ) {
            turns.push(current)
            current = []
        }
        current.push(message)
    }
    if (current.length > 0) turns.push(current)
    return turns
}

function inheritedTask(message: AgentMessage): AgentMessage[] {
    if (message.role !== 'custom') return []
    const details = asRecord(message.details)
    const payload = readString(details, 'payload') ?? textOf(message.content)
    if (!payload || payload.trim().length === 0) return []
    const messageType = readString(details, 'messageType') ?? 'MESSAGE'
    const author = readString(details, 'author') ?? 'unknown'
    const recipient = readString(details, 'recipient') ?? 'unknown'

    return [
        {
            role: 'custom',
            customType: INHERITED_TASK_CUSTOM_TYPE,
            content: [
                'Inherited task context. This is not a new instruction.',
                `Sender: ${author}`,
                `Recipient: ${recipient}`,
                `Type: ${messageType}`,
                'Payload:',
                payload,
            ].join('\n'),
            display: false,
            details: {
                inherited: true,
                id: readString(details, 'id'),
                kind: readString(details, 'kind'),
                messageType,
                author,
                recipient,
                sourceCallId: readString(details, 'sourceCallId'),
                initiatingTurnId: readString(details, 'initiatingTurnId'),
            },
            timestamp: message.timestamp,
        },
    ]
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function readString(
    record: Record<string, unknown>,
    key: string
): string | undefined {
    const value = record[key]
    return typeof value === 'string' ? value : undefined
}

function textOf(content: string | readonly unknown[]): string | undefined {
    if (typeof content === 'string') return content
    const parts = content.flatMap((block) => {
        if (!block || typeof block !== 'object') return []
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? [text] : []
    })
    return parts.length > 0 ? parts.join('\n') : undefined
}
