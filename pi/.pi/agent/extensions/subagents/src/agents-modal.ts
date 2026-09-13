/**
 * Interactive `/agents` modal: tree overview with per-agent drill-down.
 * Thin UI layer over SubagentCoordinator.list + getRecordByPath; no
 * orchestration lives here. Compact by default, `t` toggles density.
 */

import type {
    ExtensionCommandContext,
    Theme,
} from '@earendil-works/pi-coding-agent'
import {
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from '@earendil-works/pi-tui'
import type { AgentRecord } from './agent-record.ts'
import type { AgentPath } from './ids.ts'
import type { ListedAgent, SubagentCoordinator } from './coordinator.ts'
import { agentDepth, shortAgentName } from './widget.ts'

const PREVIEW_CHARS = 120
const VISIBLE_COUNT = 10

export interface ModalState {
    selected: number
    expanded: Set<string>
    detailed: boolean
}

/** Minimal reader so the frame stays pure and testable. */
export interface AgentRecordReader {
    getRecordByPath(path: AgentPath): AgentRecord | undefined
}

/** Open the subagents inspector. No-op with a notice outside TUI. */
export async function showAgentsModal(
    manager: SubagentCoordinator,
    ctx: ExtensionCommandContext
): Promise<void> {
    const agents = manager.list('/root' as AgentPath)
    if (agents.length === 0) {
        ctx.ui.notify('No subagents.', 'info')
        return
    }
    if (ctx.mode !== 'tui' || !ctx.hasUI) {
        ctx.ui.notify(renderPlainList(agents), 'info')
        return
    }

    const state: ModalState = {
        selected: 0,
        expanded: new Set(),
        detailed: false,
    }

    await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
            let closed = false
            const close = () => {
                if (closed) return
                closed = true
                done()
            }
            return {
                render(width: number): string[] {
                    // Re-read on every frame so Running -> Completed flips live.
                    const live = manager.list('/root' as AgentPath)
                    state.selected = Math.max(
                        0,
                        Math.min(state.selected, Math.max(0, live.length - 1))
                    )
                    return buildAgentsModalLines(
                        live,
                        manager,
                        state,
                        Math.max(40, width),
                        theme
                    )
                },
                invalidate(): void {},
                handleInput(data: string): void {
                    const live = manager.list('/root' as AgentPath)
                    if (data === 'j') {
                        state.selected = Math.min(
                            state.selected + 1,
                            Math.max(0, live.length - 1)
                        )
                        tui.requestRender()
                        return
                    }
                    if (data === 'k') {
                        state.selected = Math.max(0, state.selected - 1)
                        tui.requestRender()
                        return
                    }
                    if (data === 't') {
                        state.detailed = !state.detailed
                        tui.requestRender()
                        return
                    }
                    if (data === 'e') {
                        if (state.expanded.size > 0) state.expanded.clear()
                        else
                            for (const a of live)
                                state.expanded.add(a.path as string)
                        tui.requestRender()
                        return
                    }
                    if (matchesKey(data, 'enter')) {
                        const current = live[state.selected]
                        if (current) {
                            const key = current.path as string
                            if (state.expanded.has(key))
                                state.expanded.delete(key)
                            else state.expanded.add(key)
                        }
                        tui.requestRender()
                        return
                    }
                    if (
                        matchesKey(data, 'escape') ||
                        data.toLowerCase() === 'q'
                    ) {
                        close()
                        return
                    }
                    tui.requestRender()
                },
                dispose(): void {
                    closed = true
                },
            }
        },
        {
            overlay: true,
            overlayOptions: {
                anchor: 'center',
                width: 62,
                minWidth: 40,
                maxHeight: '90%',
                margin: 1,
            },
        }
    )
}

/**
 * Pure modal frame in the session-stats style. Every returned line is
 * exactly `width` columns wide (padded, ANSI-aware) so no terminal
 * ghosting bleeds through the overlay.
 */
export function buildAgentsModalLines(
    agents: readonly ListedAgent[],
    reader: AgentRecordReader,
    state: ModalState,
    width: number,
    theme: Theme
): string[] {
    const frameWidth = Math.max(40, width)
    const budget = frameWidth - 4
    const border = (text: string) => theme.fg('border', text)
    const fit = (styled: string) => truncateToWidth(styled, budget, '…', false)
    const row = (styled: string) => {
        const fitted = fit(styled)
        const padding = ' '.repeat(Math.max(0, budget - visibleWidth(fitted)))
        return `${border('│')} ${fitted}${padding} ${border('│')}`
    }

    const lines: string[] = [
        theme.fg('borderAccent', `╭${'─'.repeat(frameWidth - 2)}╮`),
    ]
    const active = agents.filter((a) => a.status === 'Running').length
    const scopePlain = `${agents.length} total · ${active} active · ${state.detailed ? 'detailed' : 'compact'}`
    const titleGap = Math.max(
        1,
        budget - visibleWidth('SUBAGENTS') - visibleWidth(scopePlain) - 1
    )
    lines.push(
        row(
            `${theme.fg('accent', 'SUBAGENTS')} ${' '.repeat(titleGap)}${theme.fg('muted', scopePlain)}`
        )
    )

    const start = Math.max(
        0,
        Math.min(
            state.selected - Math.floor(VISIBLE_COUNT / 2),
            Math.max(0, agents.length - VISIBLE_COUNT)
        )
    )
    const end = Math.min(agents.length, start + VISIBLE_COUNT)
    const windowAgents = agents.slice(start, end)
    const statusCol = Math.max(
        1,
        ...windowAgents.map((agent) => modalStatusText(agent).length)
    )
    if (start > 0) lines.push(row(theme.fg('dim', '… more above')))
    for (let i = start; i < end; i += 1) {
        const agent = agents[i]
        if (!agent) continue
        const selected = i === state.selected
        const marker = selected ? theme.fg('accent', '▸') : ' '
        const indent = '  '.repeat(
            Math.min(2, agentDepth(agent.path as string))
        )
        const nameBudget = Math.max(
            4,
            budget - 4 - indent.length - statusCol - 1
        )
        const namePlain = truncateToWidth(
            `${indent}${shortAgentName(agent.path as string)}`,
            nameBudget,
            '…',
            false
        )
        const name = selected
            ? theme.fg('accent', namePlain)
            : theme.fg('text', namePlain)
        const mail = agent.hasPendingMail ? theme.fg('warning', ' ✉') : ''
        const status = theme.fg(
            'muted',
            modalStatusText(agent).padStart(statusCol)
        )
        const left = `${marker} ${modalStatusGlyph(agent, theme)} ${name}${mail}`
        const rowGap = Math.max(1, budget - visibleWidth(left) - statusCol)
        lines.push(row(`${left}${' '.repeat(rowGap)}${status}`))

        if (state.expanded.has(agent.path as string) || state.detailed) {
            for (const detail of agentDetailRows(
                agent,
                agents,
                reader,
                state.detailed
            )) {
                lines.push(row(theme.fg('dim', `  ${detail}`)))
            }
        }
    }
    if (end < agents.length) lines.push(row(theme.fg('dim', '… more below')))
    lines.push(
        row(
            theme.fg(
                'dim',
                'j/k move · enter detail · t density · e expand · q close'
            )
        )
    )
    lines.push(theme.fg('borderAccent', `╰${'─'.repeat(frameWidth - 2)}╯`))
    return lines
}

function modalStatusText(agent: Pick<ListedAgent, 'status'>): string {
    return agent.status === 'PendingInit' ? 'Starting' : agent.status
}

function modalStatusGlyph(
    agent: Pick<ListedAgent, 'status'>,
    theme: Theme
): string {
    switch (agent.status) {
        case 'Running':
            return theme.fg('accent', '●')
        case 'Completed':
            return theme.fg('success', '✓')
        case 'Errored':
            return theme.fg('warning', '!')
        default:
            return theme.fg('dim', '○')
    }
}

/** Plain-text detail rows; the caller dims and pads them. */
function agentDetailRows(
    agent: ListedAgent,
    all: readonly ListedAgent[],
    reader: AgentRecordReader,
    detailed: boolean
): string[] {
    const rows: string[] = []
    const record = reader.getRecordByPath(agent.path)
    const children = all.filter((a) => a.parentPath === agent.path).length
    const meta = [
        agent.model !== 'root' ? agent.model : '',
        agent.residency,
        children > 0 ? `${children} child${children === 1 ? '' : 'ren'}` : '',
    ]
        .filter(Boolean)
        .join(' · ')
    if (meta) rows.push(meta)

    if (record?.usage) {
        const u = record.usage
        const tokens = u.input + u.output + u.cacheRead + u.cacheWrite
        const tools = [...u.toolCalls]
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .slice(0, detailed ? 5 : 3)
            .map((t) => `${t.name}×${t.count}`)
            .join(' ')
        const usageLine = [
            tokens > 0 ? `${formatNumber(tokens)} tokens` : '',
            u.cost > 0 ? `$${u.cost.toFixed(4)}` : '',
            tools,
        ]
            .filter(Boolean)
            .join(' · ')
        if (usageLine) rows.push(usageLine)
    }
    const preview = statusPreview(record?.status ?? null)
    if (preview) rows.push(`“${preview}”`)
    if (record) {
        const age = relativeTime(record.lastActivityAt)
        if (age) rows.push(`active ${age}`)
    }
    return rows
}

function statusPreview(
    status: { _tag: string; message?: string | null; error?: string } | null
): string | undefined {
    if (!status) return undefined
    const raw =
        status._tag === 'Completed'
            ? (status.message ?? '')
            : status._tag === 'Errored'
              ? (status.error ?? '')
              : ''
    const single = raw.trim().replace(/\s+/g, ' ')
    if (!single) return undefined
    return single.length > PREVIEW_CHARS
        ? `${single.slice(0, PREVIEW_CHARS)}…`
        : single
}

function relativeTime(timestamp: number): string | undefined {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
    const diff = Date.now() - timestamp
    if (diff < 5000) return 'just now'
    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    return `${Math.floor(minutes / 60)}h ago`
}

function formatNumber(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
    return String(value)
}

function renderPlainList(agents: ListedAgent[]): string {
    return agents
        .map(
            (a) =>
                `${a.status === 'Running' ? '●' : a.status === 'Completed' ? '✓' : '○'} ${shortAgentName(a.path as string)} ${a.status}`
        )
        .join('\n')
}
