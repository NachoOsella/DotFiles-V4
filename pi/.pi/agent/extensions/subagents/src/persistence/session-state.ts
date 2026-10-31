import {
    isPersistedStateV3,
    migratePersistedStateV2ToV3,
    parsePersistedStateV2,
    parsePersistedStateV3,
    type PersistedSubagentStateV3,
} from './schema.ts'

export const SUBAGENTS_STATE_CUSTOM_TYPE = 'subagents-v3-state'
export const SUBAGENT_META_CUSTOM_TYPE = 'subagents-v3-agent-meta'

export type PersistedState = PersistedSubagentStateV3

/** Parsed snapshot plus whether reading it changed the saved shape. */
export interface PersistedStateRead {
    readonly state: PersistedState
    /** Set when a version 2 checkpoint was migrated in memory. */
    readonly migratedFromVersion?: 2
    /** True when normalization or migration changed the saved shape. */
    readonly repaired: boolean
}

/**
 * Strict, honest guard. It is true only when the value already conforms to
 * the declared V3 shape; snapshots that need repair or migration should go
 * through `parsePersistedState` instead.
 */
export function isPersistedState(value: unknown): value is PersistedState {
    return isPersistedStateV3(value)
}

/**
 * Read a snapshot and report migration or repair.
 *
 * Version 3 goes through deep normalization. Version 2 is migrated in memory
 * to version 3 with an empty task list and no archive markers, and is always
 * reported as migrated/repaired so callers can rewrite the next checkpoint as
 * version 3. Unknown versions are rejected rather than guessed.
 */
export function readPersistedState(
    value: unknown
): PersistedStateRead | undefined {
    const v3 = parsePersistedStateV3(value)
    if (v3 !== undefined) {
        return { state: v3, repaired: !isPersistedStateV3(value) }
    }
    const v2 = parsePersistedStateV2(value)
    if (v2 !== undefined) {
        return {
            state: migratePersistedStateV2ToV3(v2),
            migratedFromVersion: 2,
            repaired: true,
        }
    }
    return undefined
}

/**
 * Recovery normalizer for V3 snapshots, with in-memory V2 migration.
 *
 * A snapshot is discarded only when the envelope cannot be used at all.
 * Within a usable snapshot every record is validated on its own and malformed
 * records are dropped, so one corrupt entry never discards valid siblings.
 * Recoverable fields (timestamps, counters, status tags, parent paths,
 * optional strings, tasks) are coerced to safe defaults. Returns undefined
 * instead of throwing on anything unexpected.
 *
 * Older V1 entries or the retired `subagents-v2-state` custom type are
 * intentionally ignored, never migrated.
 */
export function parsePersistedState(
    value: unknown
): PersistedState | undefined {
    return readPersistedState(value)?.state
}

export function snapshotAge(snapshot: PersistedState): number | undefined {
    return typeof snapshot.persistedAt === 'number' &&
        Number.isFinite(snapshot.persistedAt)
        ? snapshot.persistedAt
        : undefined
}

/**
 * Find the latest usable V3 snapshot on the branch, migrating V2 entries.
 * A snapshot that declared agents but recovered none is skipped so an earlier
 * checkpoint can still supply valid identities.
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
