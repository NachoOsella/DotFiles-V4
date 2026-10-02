import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AgentPath } from './ids.ts'

export interface ModelIdentity {
    readonly provider: string
    readonly id: string
}

export interface ParentExecutionSnapshot {
    readonly path: AgentPath
    readonly cwd: string
    readonly model: ModelIdentity
    readonly thinkingLevel: ThinkingLevel
    readonly activeTools: readonly string[]
    /** Active branch entries; the fork applies compaction and context edits. */
    readonly contextEntries: readonly SessionEntry[]
    readonly sessionFile?: string
    readonly sessionId: string
}
