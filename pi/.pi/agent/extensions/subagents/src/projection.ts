/**
 * Pure TUI projection: SubagentEvent -> compact render state.
 * Elapsed-time ticks are local UI timers, never domain events.
 * There is no queued state: capacity rejects immediately.
 */

import type { AgentId, AgentPath } from './ids.ts'
import type { SubagentEvent } from './events.ts'

export interface AgentRow {
    readonly id: AgentId
    readonly path: AgentPath
    readonly status: string
    readonly current: string
    readonly elapsedMs: number
    readonly startedAt: number
}

export interface SubagentUiState {
    readonly rows: ReadonlyArray<AgentRow>
    readonly capacityNote: string | null
    readonly collapsedSummary: string | null
}

export function emptyUiState(): SubagentUiState {
    return { rows: [], capacityNote: null, collapsedSummary: null }
}

function withRow(
    state: SubagentUiState,
    id: AgentId,
    update: (row: AgentRow) => AgentRow
): SubagentUiState {
    return {
        ...state,
        rows: state.rows.map((row) => (row.id === id ? update(row) : row)),
    }
}

/** Fold one domain event into render state (pure, testable). */
export function reduceUiState(
    previous: SubagentUiState,
    event: SubagentEvent,
    now: number = Date.now()
): SubagentUiState {
    switch (event._tag) {
        case 'ActivityStarted': {
            if (previous.rows.some((r) => r.id === event.agentId))
                return previous
            return {
                ...previous,
                capacityNote: null,
                collapsedSummary: null,
                rows: [
                    ...previous.rows,
                    {
                        id: event.agentId,
                        path: event.agentPath,
                        status: 'Running',
                        current: 'Starting',
                        elapsedMs: 0,
                        startedAt: now,
                    },
                ],
            }
        }
        case 'ActivityInteracted':
            return previous
        case 'ToolActivity':
            return withRow(previous, event.agentId, (row) => ({
                ...row,
                current: [...event.summary].slice(0, 80).join(''),
            }))
        case 'StatusChanged': {
            const label = statusLabel(event.current._tag)
            const current =
                event.current._tag === 'Completed'
                    ? truncate(event.current.message ?? 'Completed', 80)
                    : event.current._tag === 'Errored'
                      ? `Errored: ${truncate(event.current.error, 60)}`
                      : label
            // Status may arrive before ActivityStarted when a turn resolves
            // fast; ensure the row exists so terminal states always render.
            const exists = previous.rows.some((r) => r.id === event.agentId)
            const base: SubagentUiState = exists
                ? previous
                : {
                      ...previous,
                      rows: [
                          ...previous.rows,
                          {
                              id: event.agentId,
                              path: `unknown:${event.agentId}` as AgentPath,
                              status: 'Pending',
                              current: 'Starting',
                              elapsedMs: 0,
                              startedAt: now,
                          },
                      ],
                  }
            const next = withRow(base, event.agentId, (row) => ({
                ...row,
                status: label,
                current,
                elapsedMs: now - row.startedAt,
            }))
            return maybeCollapse(next)
        }
        case 'ActivityCompleted':
            return withRow(previous, event.agentId, (row) => ({
                ...row,
                status: 'Completed',
                current: row.current === 'Starting' ? 'Completed' : row.current,
                elapsedMs: now - row.startedAt,
            }))
        case 'ActivityInterrupted':
            return withRow(previous, event.agentId, (row) => ({
                ...row,
                status: 'Interrupted',
                current: 'Interrupted, available for follow-up',
                elapsedMs: now - row.startedAt,
            }))
        case 'CommunicationEnqueued':
        case 'CommunicationDelivered':
        case 'ResidencyChanged':
            return previous
    }
}

function maybeCollapse(state: SubagentUiState): SubagentUiState {
    const active = state.rows.filter((r) => r.status === 'Running')
    if (active.length > 0 || state.rows.length === 0) {
        return { ...state, collapsedSummary: null }
    }
    const completed = state.rows.filter((r) => r.status === 'Completed').length
    const errored = state.rows.filter((r) => r.status === 'Errored').length
    if (state.rows.length >= 2) {
        return {
            ...state,
            collapsedSummary: `Agents ${completed} completed, ${errored} errored`,
        }
    }
    return state
}

function statusLabel(tag: string): string {
    switch (tag) {
        case 'PendingInit':
            return 'Pending'
        case 'Running':
            return 'Running'
        case 'Interrupted':
            return 'Interrupted'
        case 'Completed':
            return 'Completed'
        case 'Errored':
            return 'Errored'
        case 'Shutdown':
            return 'Shutdown'
        default:
            return tag
    }
}

function truncate(value: string, max: number): string {
    return [...value].length > max
        ? `${[...value].slice(0, max).join('')}…`
        : value
}

/** Bounded activity ring: descriptions only, never raw output. */
export interface ActivityLine {
    readonly text: string
    readonly at: number
}

const MAX_ACTIVITY_LINES = 8
const MAX_SUMMARY_GRAPHEMES = 240

export function pushActivity(
    lines: readonly ActivityLine[],
    text: string,
    at: number = Date.now()
): readonly ActivityLine[] {
    const clean = [...text]
        .slice(0, MAX_SUMMARY_GRAPHEMES)
        .join('')
        .replace(/[\r\n]+/g, ' ')
    const next = [...lines, { text: clean, at }]
    return next.slice(Math.max(0, next.length - MAX_ACTIVITY_LINES))
}

/** Compact one-line summary per agent for the widget. */
export function compactRowText(row: AgentRow): string {
    const statusGlyph =
        row.status === 'Running'
            ? '●'
            : row.status === 'Completed'
              ? '✓'
              : row.status === 'Errored'
                ? '!'
                : '○'
    const elapsed = `${Math.round(row.elapsedMs / 1000)}s`
    return `${statusGlyph} ${row.path} ${row.current} ${elapsed}`
}
