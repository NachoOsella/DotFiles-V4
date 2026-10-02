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

/** Project Pi's active structured context into a child conversation. */
export function projectFork(
    entries: readonly SessionEntry[],
    fork: ForkTurns
): AgentMessage[] {
    if (fork._tag === 'None') return []

    const projected = buildSessionProjection([...entries]).messages.flatMap(
        projectMessage
    )
    if (fork._tag === 'All') return projected

    const baseline = projected.filter(isBaseline)
    const turns = groupTurns(
        projected.filter((message) => !isBaseline(message))
    )
    return [...baseline, ...turns.slice(-fork.turns).flat()]
}

function projectMessage(message: AgentMessage): AgentMessage[] {
    if (message.role === 'toolResult' || message.role === 'bashExecution') {
        return []
    }
    if (message.role === 'assistant') {
        if (message.stopReason !== 'stop' && message.stopReason !== 'length') {
            return []
        }
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
        return []
    }
    return [message]
}

function isBaseline(message: AgentMessage): boolean {
    return (
        message.role === 'compactionSummary' || message.role === 'branchSummary'
    )
}

/** Group input plus its final assistant response into logical turns. */
function groupTurns(messages: readonly AgentMessage[]): AgentMessage[][] {
    const turns: AgentMessage[][] = []
    let current: AgentMessage[] = []
    let hasFinalAssistant = false

    for (const message of messages) {
        const startsInput = message.role === 'user' || message.role === 'custom'
        if (startsInput && current.length > 0 && hasFinalAssistant) {
            turns.push(current)
            current = []
            hasFinalAssistant = false
        }
        current.push(message)
        if (message.role === 'assistant') hasFinalAssistant = true
    }
    if (current.length > 0) turns.push(current)
    return turns
}
