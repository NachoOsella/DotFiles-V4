import {
    isPersistedStateV2,
    type PersistedSubagentStateV2,
} from './persistence-v3.ts'

export const SUBAGENTS_STATE_CUSTOM_TYPE = 'subagents-v3-state'
export const LEGACY_SUBAGENTS_STATE_CUSTOM_TYPE = 'subagents-v2-state'

export interface LegacyPersistedState {
    readonly version: 1
    readonly rootSessionId: string
    readonly persistedAt?: number
    readonly agents: readonly Record<string, unknown>[]
}

export type PersistedState = PersistedSubagentStateV2 | LegacyPersistedState

export function isPersistedState(value: unknown): value is PersistedState {
    if (isPersistedStateV2(value)) return true
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        record.version === 1 &&
        typeof record.rootSessionId === 'string' &&
        Array.isArray(record.agents)
    )
}

export function snapshotAge(snapshot: PersistedState): number | undefined {
    return typeof snapshot.persistedAt === 'number' &&
        Number.isFinite(snapshot.persistedAt)
        ? snapshot.persistedAt
        : undefined
}

/** Find the latest V3 snapshot, while accepting one legacy snapshot for migration. */
export function findLatestState(
    branch: readonly unknown[]
): PersistedState | undefined {
    for (let i = branch.length - 1; i >= 0; i -= 1) {
        const entry = branch[i] as {
            type?: unknown
            customType?: unknown
            data?: unknown
        } | null
        if (!entry || typeof entry !== 'object') continue
        if (
            entry.type === 'custom' &&
            (entry.customType === SUBAGENTS_STATE_CUSTOM_TYPE ||
                entry.customType === LEGACY_SUBAGENTS_STATE_CUSTOM_TYPE) &&
            isPersistedState(entry.data)
        ) {
            return entry.data
        }
    }
    return undefined
}
