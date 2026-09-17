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
    wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { AgentRecord } from './agent-record.ts'
import type { ActivityEntry, ActivityKind } from './activity-feed.ts'
import type { AgentPath } from './ids.ts'
import type {
    AgentTurnPreview,
    ListedAgent,
    SubagentCoordinator,
} from './coordinator.ts'
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
    getRecentTurns?(path: AgentPath): readonly AgentTurnPreview[]
}

export interface DashboardState {
    selected: number
    focus: 'agents' | 'activity'
    scroll: number
    followTail: boolean
    narrowPanel: 'agents' | 'activity'
    hiddenKinds: Set<ActivityKind>
    seenByPath: Map<string, number>
}

const dashboardState: DashboardState = {
    selected: 0,
    focus: 'agents',
    scroll: 0,
    followTail: true,
    narrowPanel: 'agents',
    hiddenKinds: new Set(),
    seenByPath: new Map(),
}

/** Open a full-screen live inspector. No-op with a notice outside TUI. */
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

    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        let closed = false
        const unsubscribe = manager.onEvent(() => tui.requestRender())
        const close = () => {
            if (closed) return
            closed = true
            unsubscribe()
            done()
        }
        return {
            render(width: number): string[] {
                const live = manager.list('/root' as AgentPath)
                dashboardState.selected = Math.max(
                    0,
                    Math.min(
                        dashboardState.selected,
                        Math.max(0, live.length - 1)
                    )
                )
                const height = Math.max(12, (process.stdout.rows ?? 24) - 1)
                return buildAgentsDashboardLines(
                    live,
                    manager,
                    dashboardState,
                    Math.max(40, width),
                    height,
                    theme
                )
            },
            invalidate(): void {},
            handleInput(data: string): void {
                const live = manager.list('/root' as AgentPath)
                const page = Math.max(
                    4,
                    Math.floor((process.stdout.rows ?? 24) / 2)
                )
                if (matchesKey(data, 'escape') || data.toLowerCase() === 'q') {
                    close()
                    return
                }
                if (matchesKey(data, 'tab') || data === 'h' || data === 'l') {
                    dashboardState.focus =
                        dashboardState.focus === 'agents'
                            ? 'activity'
                            : 'agents'
                    dashboardState.narrowPanel = dashboardState.focus
                } else if (data === '1') {
                    toggleKind(dashboardState.hiddenKinds, 'thinking')
                } else if (data === '2') {
                    toggleKind(dashboardState.hiddenKinds, 'tool')
                } else if (data === '3') {
                    toggleKind(dashboardState.hiddenKinds, 'tool_result')
                } else if (dashboardState.focus === 'agents') {
                    if (data === 'j' || matchesKey(data, 'down')) {
                        dashboardState.selected = Math.min(
                            dashboardState.selected + 1,
                            Math.max(0, live.length - 1)
                        )
                        dashboardState.scroll = 0
                        dashboardState.followTail = true
                    } else if (data === 'k' || matchesKey(data, 'up')) {
                        dashboardState.selected = Math.max(
                            0,
                            dashboardState.selected - 1
                        )
                        dashboardState.scroll = 0
                        dashboardState.followTail = true
                    } else if (data === 'g') dashboardState.selected = 0
                    else if (data === 'G')
                        dashboardState.selected = Math.max(0, live.length - 1)
                } else if (data === 'j' || matchesKey(data, 'down')) {
                    dashboardState.scroll += 1
                    dashboardState.followTail = dashboardState.scroll === 0
                } else if (data === 'k' || matchesKey(data, 'up')) {
                    dashboardState.scroll += 1
                    dashboardState.followTail = false
                } else if (data === 'g') {
                    dashboardState.scroll = Number.MAX_SAFE_INTEGER
                    dashboardState.followTail = false
                } else if (data === 'G') {
                    dashboardState.scroll = 0
                    dashboardState.followTail = true
                } else if (matchesKey(data, 'ctrl+u')) {
                    dashboardState.scroll += page
                    dashboardState.followTail = false
                } else if (matchesKey(data, 'ctrl+d')) {
                    dashboardState.scroll = Math.max(
                        0,
                        dashboardState.scroll - page
                    )
                    dashboardState.followTail = dashboardState.scroll === 0
                }
                tui.requestRender()
            },
            dispose(): void {
                closed = true
                unsubscribe()
            },
        }
    })
}

export function buildAgentsDashboardLines(
    agents: readonly ListedAgent[],
    reader: AgentRecordReader & {
        getActivity(path: AgentPath): readonly ActivityEntry[]
    },
    state: DashboardState,
    width: number,
    height: number,
    theme: Theme
): string[] {
    const contentHeight = Math.max(4, height - 4)
    const narrow = width < 90
    const selected = agents[state.selected]
    const selectedPath = selected?.path
    const activity = selectedPath
        ? reader
              .getActivity(selectedPath)
              .filter((entry) => !state.hiddenKinds.has(entry.kind))
        : []
    const latestId = activity.at(-1)?.id ?? 0
    if (
        selectedPath &&
        (!narrow || state.narrowPanel === 'activity') &&
        state.followTail
    ) {
        state.seenByPath.set(selectedPath as string, latestId)
    }

    const title = theme.fg('accent', theme.bold('SUBAGENTS'))
    const active = agents.filter((agent) => agent.running).length
    const headerRight = theme.fg(
        'muted',
        `${agents.length} total · ${active} active · ${state.followTail ? 'following' : 'paused'}`
    )
    const header = fillBetween(title, headerRight, width)
    const footer = theme.fg(
        'dim',
        'tab panel · j/k move · g/G top/bottom · ^u/^d page · 1/2/3 filter · q close'
    )
    const rule = theme.fg('borderMuted', '─'.repeat(width))
    const record = selectedPath
        ? reader.getRecordByPath(selectedPath)
        : undefined
    const task = record?.task?.trim() ? record.task.trim() : ''
    const subtitle = record
        ? [
              record.model,
              record.thinkingLevel ? `thinking:${record.thinkingLevel}` : '',
              selected?.residency ?? '',
          ]
              .filter(Boolean)
              .join(' · ')
        : ''

    let body: string[]
    if (narrow) {
        body =
            state.narrowPanel === 'agents'
                ? renderAgentPanel(
                      agents,
                      reader,
                      state,
                      width,
                      contentHeight,
                      theme
                  )
                : renderActivityPanel(
                      selected,
                      activity,
                      subtitle,
                      task,
                      state,
                      width,
                      contentHeight,
                      theme
                  )
    } else {
        const leftWidth = Math.max(28, Math.min(38, Math.floor(width * 0.3)))
        const rightWidth = width - leftWidth - 1
        const left = renderAgentPanel(
            agents,
            reader,
            state,
            leftWidth,
            contentHeight,
            theme
        )
        const right = renderActivityPanel(
            selected,
            activity,
            subtitle,
            task,
            state,
            rightWidth,
            contentHeight,
            theme
        )
        body = Array.from(
            { length: contentHeight },
            (_, index) =>
                `${padLine(left[index] ?? '', leftWidth)}${theme.fg('borderMuted', '│')}${padLine(right[index] ?? '', rightWidth)}`
        )
    }

    return [
        padLine(header, width),
        rule,
        ...body,
        rule,
        padLine(truncateToWidth(footer, width, '', false), width),
    ].slice(0, height)
}

function renderAgentPanel(
    agents: readonly ListedAgent[],
    reader: AgentRecordReader & {
        getActivity(path: AgentPath): readonly ActivityEntry[]
    },
    state: DashboardState,
    width: number,
    height: number,
    theme: Theme
): string[] {
    const rows = [
        theme.fg(
            state.focus === 'agents' ? 'accent' : 'muted',
            theme.bold(`AGENTS · ${agents.length}`)
        ),
    ]
    const visible = Math.max(1, Math.floor((height - 1) / 2))
    const start = Math.max(
        0,
        Math.min(
            state.selected - Math.floor(visible / 2),
            Math.max(0, agents.length - visible)
        )
    )
    for (
        let index = start;
        index < Math.min(agents.length, start + visible);
        index++
    ) {
        const agent = agents[index]!
        const selected = index === state.selected
        const entries = reader.getActivity(agent.path)
        const seen = state.seenByPath.get(agent.path as string) ?? 0
        const unread = entries.filter((entry) => entry.id > seen).length
        const record = reader.getRecordByPath(agent.path)
        const elapsed = record?.lastActivityAt
            ? shortElapsed(record.lastActivityAt)
            : ''
        // Meta stays short on purpose: status, thinking, elapsed always fit
        // the 28-38 column panel. The full model lives in the detail title.
        const marker = selected ? theme.fg('accent', '▸') : ' '
        const glyph = modalStatusGlyph(agent, theme)
        const badge = unread > 0 ? theme.fg('warning', ` +${unread}`) : ''
        const name = shortAgentName(agent.path as string)
        const nameStyled = selected
            ? theme.fg('accent', theme.bold(name))
            : name
        const meta = [agent.status, record?.thinkingLevel, elapsed]
            .filter(Boolean)
            .join(' · ')
        rows.push(
            truncateToWidth(
                `${marker} ${glyph} ${nameStyled}${badge}`,
                width,
                '…',
                false
            )
        )
        rows.push(
            truncateToWidth(theme.fg('dim', `    ${meta}`), width, '…', false)
        )
    }
    return padRows(rows, height, width)
}

function renderActivityPanel(
    agent: ListedAgent | undefined,
    activity: readonly ActivityEntry[],
    subtitle: string,
    task: string,
    state: DashboardState,
    width: number,
    height: number,
    theme: Theme
): string[] {
    const collapsed = collapseRedundant(activity)
    const title = agent
        ? `${shortAgentName(agent.path as string)} · ${agent.status}${agent.running ? ' ●' : ''}`
        : 'ACTIVITY'
    const rows = [
        theme.fg(
            state.focus === 'activity' ? 'accent' : 'muted',
            theme.bold(truncateToWidth(title, width, '…', false))
        ),
    ]
    if (subtitle) {
        rows.push(theme.fg('dim', truncateToWidth(subtitle, width, '…', false)))
    }
    if (task) {
        rows.push(theme.fg('accent', theme.bold('◆ TASK')))
        const taskWidth = Math.max(20, width - 2)
        const rail = theme.fg('accent', '│')
        for (const line of wrapTextWithAnsi(task, taskWidth)) {
            rows.push(`${rail} ${line}`)
        }
        rows.push('')
    }
    const eventRows = collapsed.flatMap((entry) =>
        renderActivityEntry(entry, width, theme)
    )
    const available = Math.max(1, height - rows.length)
    const maxScroll = Math.max(0, eventRows.length - available)
    state.scroll = Math.min(state.scroll, maxScroll)
    const end = Math.max(0, eventRows.length - state.scroll)
    const start = Math.max(0, end - available)
    rows.push(...eventRows.slice(start, end))
    if (eventRows.length === 0) rows.push(theme.fg('dim', 'No activity yet.'))
    return padRows(rows, height, width)
}

/** Timeline entry with a merged tool outcome (`→ done`) when applicable. */
export interface RenderEntry extends ActivityEntry {
    readonly doneAt?: number
}

/**
 * Merge a `tool X` call with its immediately following `X completed` result,
 * and drop an identical message shadowed by its terminal `final` payload.
 * Pure so the timeline stays truthful without showing the same text twice.
 */
export function collapseRedundant(
    entries: readonly ActivityEntry[]
): RenderEntry[] {
    const out: RenderEntry[] = []
    for (const entry of entries) {
        const last = out.at(-1)
        if (
            last &&
            last.summary.trim() === entry.summary.trim() &&
            ((last.kind === 'message' && entry.kind === 'final') ||
                (last.kind === entry.kind && entry.kind !== 'tool'))
        ) {
            if (entry.kind === 'final') {
                out[out.length - 1] = { ...entry }
            }
            continue
        }
        if (
            last &&
            last.kind === 'tool' &&
            entry.kind === 'tool_result' &&
            toolNameOf(last.summary) === toolNameOf(entry.summary) &&
            /completed\s*$/.test(entry.summary)
        ) {
            out[out.length - 1] = { ...last, doneAt: entry.at }
            continue
        }
        if (
            entry.kind === 'tool_result' &&
            /completed\s*$/.test(entry.summary)
        ) {
            continue
        }
        out.push({ ...entry })
    }
    return out
}

function toolNameOf(summary: string): string {
    return summary.trim().split(/\s+/, 1)[0] ?? ''
}

function renderActivityEntry(
    entry: RenderEntry,
    width: number,
    theme: Theme
): string[] {
    const time = formatClock(entry.at)
    const live = entry.live ? theme.fg('accent', ' ●live') : ''
    const bodyWidth = Math.max(20, width - 2)
    type Color = Parameters<Theme['fg']>[0]
    const rail = (color: Color) => theme.fg(color, '│')
    const guttered = (color: Color, text: string): string[] => {
        const clean = text.trim().replace(/\s+/g, ' ')
        if (!clean) return []
        return wrapTextWithAnsi(clean, bodyWidth).map(
            (line) => `${rail(color)} ${line}`
        )
    }
    switch (entry.kind) {
        case 'tool': {
            const parsed = String(entry.summary).match(/^(\S+)\s+([\s\S]*)$/)
            const toolName = parsed?.[1] ?? String(entry.summary)
            const rest = (parsed?.[2] ?? '').trim()
            const outcome = entry.doneAt
                ? theme.fg(
                      'dim',
                      ` → done in ${formatDuration(entry.doneAt - entry.at)}`
                  )
                : theme.fg('warning', ' → running')
            const rows = [
                padLine(
                    `${theme.fg('dim', 'TOOL ·')} ${theme.fg('toolTitle', theme.bold(toolName))} ${theme.fg('dim', `· ${time}`)}${live}`,
                    width
                ),
            ]
            if (rest) {
                rows.push(
                    truncateToWidth(
                        `${rail('toolTitle')} ${rest}`,
                        width,
                        '…',
                        false
                    )
                )
            }
            rows.push(padLine(`${rail('toolTitle')}${outcome}`, width), '')
            return rows
        }
        case 'tool_result': {
            const toolName = toolNameOf(String(entry.summary))
            return [
                padLine(
                    `${theme.fg('error', theme.bold('! FAILED'))} ${theme.fg('toolTitle', theme.bold(toolName))} ${theme.fg('dim', `· ${time}`)}`,
                    width
                ),
                ...guttered('error', String(entry.summary)),
                '',
            ]
        }
        case 'thinking': {
            const wrapped = guttered('dim', entry.summary)
            const cap = 8
            const shown = wrapped
                .slice(0, cap)
                .map((line) => theme.fg('dim', line))
            if (wrapped.length > cap) {
                shown.push(
                    theme.fg(
                        'dim',
                        `${rail('dim')} … +${wrapped.length - cap} more`
                    )
                )
            }
            return [
                padLine(
                    `${theme.fg('dim', 'THINK')} ${theme.fg('dim', `· ${time}`)}${live}`,
                    width
                ),
                ...shown,
                '',
            ]
        }
        case 'final': {
            return [
                padLine(
                    `${theme.fg('success', theme.bold('✓ FINAL'))} ${theme.fg('dim', `· ${time}`)}`,
                    width
                ),
                ...guttered('success', entry.summary),
                '',
            ]
        }
        default: {
            return [
                padLine(
                    `${theme.fg('muted', 'TEXT')} ${theme.fg('dim', `· ${time}`)}${live}`,
                    width
                ),
                ...guttered('muted', entry.summary),
                '',
            ]
        }
    }
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatClock(at: number): string {
    const date = new Date(at)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
}

function shortElapsed(at: number): string {
    const diff = Date.now() - at
    if (diff < 5000) return 'now'
    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h`
}

function toggleKind(hidden: Set<ActivityKind>, kind: ActivityKind): void {
    if (hidden.has(kind)) hidden.delete(kind)
    else hidden.add(kind)
}

function padRows(rows: string[], height: number, width: number): string[] {
    const fitted = rows.slice(0, height).map((row) => padLine(row, width))
    while (fitted.length < height) fitted.push(' '.repeat(width))
    return fitted
}

function padLine(content: string, width: number): string {
    const fitted = truncateToWidth(content, width, '', false)
    return `${fitted}${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}`
}

function fillBetween(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
    return truncateToWidth(
        `${left}${' '.repeat(gap)}${right}`,
        width,
        '',
        false
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
                state.detailed,
                state.expanded.has(agent.path as string)
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
    detailed: boolean,
    showTurns: boolean
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
    if (showTurns) {
        const turns = reader.getRecentTurns?.(agent.path) ?? []
        if (turns.length > 0) rows.push('last 10 turns')
        for (const turn of turns) {
            const text =
                turn.text.length > PREVIEW_CHARS
                    ? `${turn.text.slice(0, PREVIEW_CHARS)}…`
                    : turn.text
            rows.push(`${turn.role}: ${text}`)
        }
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
