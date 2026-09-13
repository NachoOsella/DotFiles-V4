import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { AgentPath } from './ids.ts'

export interface AgentRuntime {
    readonly path: AgentPath
    readonly session: AgentSession
    readonly sessionFile?: string
    runSequence: number
    currentRun?: Promise<void>
    activePermitSequence?: number
    interruptRequested: boolean
    lastTouched: number
    endpoint?: import('./transport.ts').CommunicationEndpoint
    dispose(): Promise<void>
}

/** Serialize only admission decisions for one agent. */
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
    onActivity?: (summary: string) => void
}): AgentRuntime {
    const unsubscribe = args.session.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
            args.onActivity?.(`tool ${event.toolName}`)
        } else if (event.type === 'message_update') {
            args.onActivity?.('thinking')
        }
    })

    return {
        path: args.path,
        session: args.session,
        sessionFile: args.session.sessionFile,
        runSequence: 0,
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
