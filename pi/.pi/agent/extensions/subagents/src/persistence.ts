/**
 * Session persistence helpers. Only plain data crosses this boundary;
 * live Fibers, Scopes, Deferreds, and session handles are never stored.
 */

import type { PersistedMultiAgentState } from './manager.ts'

export const SUBAGENTS_STATE_CUSTOM_TYPE = 'subagents-v2-state'

/** True when a CustomEntry payload looks like our persisted state. */
export function isPersistedState(
    value: unknown
): value is PersistedMultiAgentState {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return (
        record.version === 1 &&
        typeof record.rootSessionId === 'string' &&
        Array.isArray(record.agents)
    )
}

/** Wall-clock ms when a snapshot was written, if present. */
export function snapshotAge(
    snapshot: PersistedMultiAgentState
): number | undefined {
    return typeof snapshot.persistedAt === 'number' &&
        Number.isFinite(snapshot.persistedAt)
        ? snapshot.persistedAt
        : undefined
}

/** Find the latest persisted snapshot on a session branch. */
export function findLatestState(
    branch: readonly unknown[]
): PersistedMultiAgentState | undefined {
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
            if (isPersistedState(entry.data)) return entry.data
        }
    }
    return undefined
}
