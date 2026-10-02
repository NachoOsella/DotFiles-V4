import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ActivityKind } from './activity-feed.ts'
import type { AgentPath } from './ids.ts'

export type AgentRunPhase = 'idle' | 'running' | 'settling'

export interface LiveActivity {
    readonly action: 'push' | 'update' | 'commit'
    readonly kind?: ActivityKind
    readonly summary?: string
    /** Tool call this activity describes, when it describes one. */
    readonly toolCallId?: string
    /** True when another tool, such as a codemode script, made the call. */
    readonly nested?: boolean
}

export interface AgentRuntime {
    readonly path: AgentPath
    readonly session: AgentSession
    readonly sessionFile?: string
    runSequence: number
    phase: AgentRunPhase
    currentRun?: Promise<void>
    activePermitSequence?: number
    interruptRequested: boolean
    lastTouched: number
    endpoint?: import('./transport.ts').CommunicationEndpoint
    dispose(): Promise<void>
}

/** Serialize a small asynchronous critical section. */
export class AgentMutex {
    private tail = Promise.resolve()

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.tail
        let release!: () => void
        this.tail = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await operation()
        } finally {
            release()
        }
    }
}

export function makeAgentRuntime(args: {
    path: AgentPath
    session: AgentSession
    runSequence?: number
    onActivity?: (activity: LiveActivity) => void
}): AgentRuntime {
    const unsubscribe = args.session.subscribe((event) => {
        if (event.type === 'message_update') {
            const content = extractAssistantContent(event.message)
            args.onActivity?.({
                action: 'update',
                kind: 'thinking',
                summary: content.thinking,
            })
            args.onActivity?.({
                action: 'update',
                kind: 'message',
                summary: content.text,
            })
            return
        }
        if (event.type === 'message_end') {
            args.onActivity?.({ action: 'commit' })
            return
        }
        if (event.type === 'tool_execution_start') {
            args.onActivity?.({ action: 'commit' })
            args.onActivity?.({
                action: 'push',
                kind: 'tool',
                summary:
                    `${event.toolName} ${formatToolMetadata(event.args)}`.trim(),
                toolCallId: event.toolCallId,
                nested: event.parentToolCallId !== undefined,
            })
            return
        }
        if (event.type === 'tool_execution_end') {
            args.onActivity?.({
                action: 'push',
                kind: 'tool_result',
                summary: event.isError
                    ? `${event.toolName} failed: ${formatToolError(event.result)}`
                    : `${event.toolName} completed`,
                toolCallId: event.toolCallId,
                nested: event.parentToolCallId !== undefined,
            })
        }
    })

    return {
        path: args.path,
        session: args.session,
        sessionFile: args.session.sessionFile,
        runSequence: args.runSequence ?? 0,
        phase: 'idle',
        currentRun: undefined,
        activePermitSequence: undefined,
        interruptRequested: false,
        lastTouched: Date.now(),
        async dispose() {
            unsubscribe()
            try {
                if (args.session.isStreaming) await args.session.abort()
            } finally {
                args.session.dispose()
            }
        },
    }
}

function extractAssistantContent(message: unknown): {
    thinking: string
    text: string
} {
    if (!message || typeof message !== 'object')
        return { thinking: '', text: '' }
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return { thinking: '', text: '' }
    const thinking: string[] = []
    const text: string[] = []
    for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const item = part as {
            type?: unknown
            thinking?: unknown
            text?: unknown
        }
        if (item.type === 'thinking' && typeof item.thinking === 'string') {
            thinking.push(item.thinking)
        } else if (item.type === 'text' && typeof item.text === 'string') {
            text.push(item.text)
        }
    }
    return { thinking: thinking.join('\n'), text: text.join('\n') }
}

/**
 * First line of a failed tool result, bounded for the activity feed. The
 * inspector shows this instead of a bare "failed", which is the part that
 * tells you what to do next.
 */
function formatToolError(result: unknown): string {
    const compact = extractResultText(result).trim().replace(/\s+/g, ' ')
    if (!compact) return 'no error text'
    return compact.length > 200 ? `${compact.slice(0, 200)}…` : compact
}

function extractResultText(result: unknown): string {
    if (!result || typeof result !== 'object') return ''
    const content = (result as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .map((part) =>
            part &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'text'
                ? String((part as { text?: unknown }).text ?? '')
                : ''
        )
        .filter(Boolean)
        .join(' ')
}

function formatToolMetadata(args: unknown): string {
    if (!args || typeof args !== 'object') return ''
    const record = args as Record<string, unknown>
    const preferred = ['path', 'command', 'query', 'target', 'task_name']
    for (const key of preferred) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) {
            const compact = value.trim().replace(/\s+/g, ' ').slice(0, 180)
            // Manual quoting: JSON.stringify would double every backslash
            // and render commands as command="printf 'x/\\n'".
            if (key === 'command') return `$ ${compact}`
            return `${key}="${compact.replace(/"/g, '\\"')}"`
        }
    }
    return ''
}
