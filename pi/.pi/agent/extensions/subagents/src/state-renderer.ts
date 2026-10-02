/**
 * Transcript rendering for persisted subagent snapshots. `pi.appendEntry()`
 * stores them for resume; this module only decides how they appear in the UI.
 */

import type {
    CustomEntry,
    EntryRenderOptions,
    Theme,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import type { PersistedState } from './persistence.ts'

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
}

function statusOf(agent: unknown): string {
    const status = asRecord(agent).status
    return typeof status === 'string' ? status : 'Unknown'
}

/** Compact row for one persisted `subagents-v3-state` checkpoint. */
export function renderSubagentsState(
    entry: CustomEntry<PersistedState>,
    options: EntryRenderOptions,
    theme: Theme
) {
    const data = entry.data
    if (!data || !Array.isArray(data.agents)) return undefined
    const total = data.agents.length
    const running = data.agents.filter(
        (agent) => statusOf(agent) === 'Running'
    ).length
    const summary = [
        `${total} agent${total === 1 ? '' : 's'}`,
        running > 0 ? `${running} running` : '',
    ]
        .filter(Boolean)
        .join(' · ')
    const head =
        `${theme.style('SUBAGENTS', { fg: 'muted', bold: true })} ` +
        `${theme.fg('dim', `state · ${summary}`)}`
    if (!options.expanded) return new Text(head, 0, 0)
    const rows = data.agents.map((agent) => {
        const record = asRecord(agent)
        const path = typeof record.path === 'string' ? record.path : 'unknown'
        return (
            `${theme.fg('dim', '  ')}${theme.fg('accent', path)} ` +
            `${theme.fg('dim', statusOf(agent))}`
        )
    })
    return new Text([head, ...rows].join('\n'), 0, 0)
}
