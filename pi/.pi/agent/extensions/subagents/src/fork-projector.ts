import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { TextContent } from '@earendil-works/pi-ai'
import {
    sessionEntryToContextMessages,
    type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type { ForkTurns } from './communication.ts'

const COMMUNICATION_TYPES = new Set([
    'subagents-v2-mail',
    'subagents-v2-message',
    'subagents-v2-state',
    'subagents-v3:communication',
    'subagents-v3-state',
])

/** Project Pi's active structured context into a child conversation. */
export function projectFork(
    entries: readonly SessionEntry[],
    fork: ForkTurns
): AgentMessage[] {
    if (fork._tag === 'None') return []

    const projected = entries.flatMap(projectEntry)
    if (fork._tag === 'All') return projected

    const baseline = projected.filter(isBaseline)
    const turns = groupTurns(
        projected.filter((message) => !isBaseline(message))
    )
    return [...baseline, ...turns.slice(-fork.turns).flat()]
}

function projectEntry(entry: SessionEntry): AgentMessage[] {
    if (
        entry.type === 'model_change' ||
        entry.type === 'thinking_level_change'
    ) {
        return []
    }

    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
        const summary =
            entry.type === 'compaction' ? entry.summary : entry.summary
        return [
            {
                role: 'custom',
                customType: 'subagents-v3:fork-summary',
                content: summary,
                display: false,
                timestamp: Date.parse(entry.timestamp),
                details: { source: entry.type },
            },
        ] as AgentMessage[]
    }

    const projected: AgentMessage[] = []
    for (const message of sessionEntryToContextMessages(entry)) {
        if (message.role === 'toolResult' || message.role === 'bashExecution') {
            continue
        }
        if (message.role === 'assistant') {
            if (
                message.stopReason !== 'stop' &&
                message.stopReason !== 'length'
            ) {
                continue
            }
            const content = message.content.filter(
                (block): block is TextContent => block.type === 'text'
            )
            if (content.length === 0) continue
            projected.push({ ...message, content })
            continue
        }
        if (message.role === 'custom') {
            if (!COMMUNICATION_TYPES.has(message.customType))
                projected.push(message)
            continue
        }
        projected.push(message)
    }
    return projected
}

function isBaseline(message: AgentMessage): boolean {
    return (
        message.role === 'compactionSummary' ||
        message.role === 'branchSummary' ||
        (message.role === 'custom' &&
            message.customType === 'subagents-v3:fork-summary')
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
