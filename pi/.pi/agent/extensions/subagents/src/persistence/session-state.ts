import {
    isPersistedStateV2,
    parsePersistedStateV2,
    type PersistedSubagentStateV2,
} from './schema.ts'

export const SUBAGENTS_STATE_CUSTOM_TYPE = 'subagents-v3-state'
export const SUBAGENT_META_CUSTOM_TYPE = 'subagents-v3-agent-meta'

export type PersistedState = PersistedSubagentStateV2

/**
 * Strict, honest guard. It is true only when the value already conforms to
 * the declared V2 shape; snapshots that need repair should go through
 * `parsePersistedState` instead.
 */
export function isPersistedState(value: unknown): value is PersistedState {
    return isPersistedStateV2(value)
}

/**
 * Recovery normalizer for V2 snapshots.
 *
 * Policy: a snapshot is discarded only when its envelope is unusable.
 * Within a usable snapshot every agent record is validated on its own and
 * malformed records are dropped, so one corrupt entry never discards valid
 * siblings. Recoverable fields (timestamps, counters, status tags, parent
 * paths, optional strings) are coerced to safe defaults. Returns undefined
 * instead of throwing on anything unexpected.
 *
 * Older schemas (legacy V1 entries or the retired `subagents-v2-state`
 * custom type) are intentionally ignored, never migrated.
 */
export function parsePersistedState(
    value: unknown
): PersistedState | undefined {
    return parsePersistedStateV2(value)
}

export function snapshotAge(snapshot: PersistedState): number | undefined {
    return typeof snapshot.persistedAt === 'number' &&
        Number.isFinite(snapshot.persistedAt)
        ? snapshot.persistedAt
        : undefined
}

/**
 * Find the latest usable V2 snapshot on the branch. A snapshot that declared
 * agents but recovered none is skipped so an earlier checkpoint can still
 * supply valid identities.
 */
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
            entry.customType === SUBAGENTS_STATE_CUSTOM_TYPE
        ) {
            const parsed = parsePersistedState(entry.data)
            if (parsed === undefined) continue
            if (
                declaredAgentCount(entry.data) > 0 &&
                parsed.agents.length === 0
            ) {
                continue
            }
            return parsed
        }
    }
    return undefined
}

function declaredAgentCount(value: unknown): number {
    const record = asRecord(value)
    if (record === undefined) return 0
    return Array.isArray(record.agents) ? record.agents.length : 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined
}
