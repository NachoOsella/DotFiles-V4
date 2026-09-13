import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AgentUsageTotals } from './agent-record.ts'
import type { ModelIdentity } from './parent-snapshot.ts'

export interface PersistedSubagentV2 {
    readonly id: string
    readonly path: string
    readonly parentPath: string | null
    readonly rootSessionId: string
    readonly sessionId?: string
    readonly sessionFile?: string
    readonly cwd?: string
    readonly role?: string
    readonly model: ModelIdentity
    readonly thinkingLevel?: ThinkingLevel
    readonly activeTools: readonly string[]
    readonly status: string
    readonly statusMessage?: string
    readonly createdAt: number
    readonly lastActivityAt: number
    readonly runSequence: number
    readonly lastDeliveredRunSequence?: number
    readonly lastResult?: string
    readonly legacyUnresumable?: boolean
    readonly usage?: AgentUsageTotals
}

export interface PersistedSubagentStateV2 {
    readonly version: 2
    readonly rootSessionId: string
    readonly persistedAt: number
    readonly agents: readonly PersistedSubagentV2[]
}

export function isPersistedStateV2(
    value: unknown
): value is PersistedSubagentStateV2 {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        record.version === 2 &&
        typeof record.rootSessionId === 'string' &&
        Array.isArray(record.agents)
    )
}
