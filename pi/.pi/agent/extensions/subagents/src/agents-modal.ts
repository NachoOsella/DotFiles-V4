/**
 * Interactive `/agents` modal: tree overview with per-agent drill-down.
 * Thin UI layer over SubagentCoordinator.list + getRecordByPath; no
 * orchestration lives here. The spawn prompt is clamped; `t` expands it.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import {
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { TuiMouseEvent } from '@earendil-works/pi-tui'
import { formatDuration, formatTokens } from './format.ts'
import type { AgentRecord } from './agent-record.ts'
import type { ActivityEntry, ActivityKind } from './activity-feed.ts'
import type { AgentPath } from './ids.ts'
import type {
    AgentTurnPreview,
    ListedAgent,
    SubagentCoordinator,
} from './coordinator.ts'

const PREVIEW_CHARS = 120
const TASK_PREVIEW_LINES = 5
const FULL_FOOTER =
    'tab panel · j/k move · g/G top/bottom · ^u/^d page · 1-5 filter · t task · q close'
const COMPACT_FOOTER = 'tab · j/k · ^u/^d · 1-5 · t · q'

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
    taskExpanded: boolean
    seenByPath: Map<string, number>
}

const dashboardState: DashboardState = {
    selected: 0,
    focus: 'agents',
    scroll: 0,
    followTail: true,
    narrowPanel: 'agents',
    hiddenKinds: new Set(),
    taskExpanded: false,
    seenByPath: new Map(),
}

/** Open a full-screen live inspector. No-op with a notice outside TUI. */
export async function showAgentsModal(
    manager: SubagentCoordinator,
    ctx: ExtensionContext
): Promise<void> {
    const agents = manager.list('/root' as AgentPath)
    if (agents.length === 0) {
        ctx.ui.notify(
            'No subagents yet. spawn_agent starts one; /agents inspects them.',
            'info'
        )
        return
    }
    if (ctx.mode !== 'tui' || !ctx.hasUI) {
        ctx.ui.notify(renderPlainList(agents), 'info')
        return
    }

    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
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
                const height = Math.max(12, tui.terminal.rows - 1)
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
            handleMouse(event: TuiMouseEvent) {
                const delta = event.wheelDelta
                if (!delta) return undefined
                if (dashboardState.focus === 'agents') {
                    const live = manager.list('/root' as AgentPath)
                    const next = Math.min(
                        dashboardState.selected + (delta > 0 ? 1 : -1),
                        Math.max(0, live.length - 1)
                    )
                    dashboardState.selected = Math.max(0, next)
                    dashboardState.scroll = 0
                    dashboardState.followTail = true
                } else {
                    dashboardState.scroll = Math.max(
                        0,
                        dashboardState.scroll - delta
                    )
                    dashboardState.followTail = dashboardState.scroll === 0
                }
                tui.requestRender()
                return { handled: true }
            },
            handleInput(data: string): void {
                const live = manager.list('/root' as AgentPath)
                const page = Math.max(4, Math.floor(tui.terminal.rows / 2))
                if (
                    keybindings.matches(data, 'tui.select.cancel') ||
                    data.toLowerCase() === 'q'
                ) {
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
                } else if (data === '4') {
                    toggleKind(dashboardState.hiddenKinds, 'message')
                } else if (data === '5') {
                    toggleKind(dashboardState.hiddenKinds, 'final')
                } else if (data === 't') {
                    dashboardState.taskExpanded = !dashboardState.taskExpanded
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
    const footerHint =
        visibleWidth(FULL_FOOTER) <= width ? FULL_FOOTER : COMPACT_FOOTER
    const footer = theme.fg('dim', footerHint)
    const rule = theme.fg('borderMuted', '─'.repeat(width))
    const record = selectedPath
        ? reader.getRecordByPath(selectedPath)
        : undefined
    const task = record?.task?.trim() ? record.task.trim() : ''
    const usage = record?.usage
    const tokens = usage
        ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
        : 0
    const subtitle = record
        ? [
              record.model,
              record.thinkingLevel ? `thinking:${record.thinkingLevel}` : '',
              selected?.residency ?? '',
              tokens > 0 ? `${formatTokens(tokens)} tok` : '',
              usage && usage.cost > 0 ? `$${usage.cost.toFixed(4)}` : '',
          ]
              .filter(Boolean)
              .join(' · ')
        : ''
    const recentTurns = selectedPath
        ? (reader.getRecentTurns?.(selectedPath) ?? [])
        : []

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
                      theme,
                      recentTurns
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
            theme,
            recentTurns
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
        const silence = record?.lastActivityAt
            ? shortElapsed(record.lastActivityAt)
            : ''
        // Meta stays short on purpose: status, thinking and silence always fit
        // the 28-38 column panel. The full model lives in the detail title.
        const marker = selected ? theme.fg('accent', '▸') : ' '
        const glyph = statusGlyph(agent, theme)
        const badge = unread > 0 ? theme.fg('warning', ` +${unread}`) : ''
        const name = shortAgentName(agent.path as string)
        const nameStyled = selected
            ? theme.fg('accent', theme.bold(name))
            : name
        const meta = [
            agent.status,
            agent.waiting ? 'waiting' : '',
            record?.thinkingLevel,
            silenceLabel(agent, silence),
        ]
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
    theme: Theme,
    recentTurns: readonly AgentTurnPreview[] = []
): string[] {
    const collapsed = collapseRedundant(activity)
    const hidden = [...state.hiddenKinds]
    const filterNote = hidden.length > 0 ? ` · hidden: ${hidden.join(',')}` : ''
    const title = agent
        ? `${shortAgentName(agent.path as string)} · ${agent.status}${agent.running ? ' ●' : ''}${filterNote}`
        : `ACTIVITY${filterNote}`
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
        const wrapped = wrapTextWithAnsi(task, taskWidth)
        const cap = state.taskExpanded ? wrapped.length : TASK_PREVIEW_LINES
        for (const line of wrapped.slice(0, cap)) {
            rows.push(`${rail} ${line}`)
        }
        if (wrapped.length > cap) {
            rows.push(
                theme.fg(
                    'dim',
                    `${rail} … +${wrapped.length - cap} more lines · t`
                )
            )
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
    if (eventRows.length === 0) {
        // Nothing filtered in: show the last turns instead of a dead panel, so a
        // settled agent still says what it did.
        if (recentTurns.length > 0) {
            rows.push(theme.fg('dim', 'last turns'))
            for (const turn of recentTurns) {
                const text =
                    turn.text.length > PREVIEW_CHARS
                        ? `${turn.text.slice(0, PREVIEW_CHARS)}…`
                        : turn.text
                rows.push(
                    truncateToWidth(
                        `${theme.fg('muted', `${turn.role}:`)} ${text}`,
                        width,
                        '…',
                        false
                    )
                )
            }
        } else {
            rows.push(theme.fg('dim', 'No activity yet.'))
        }
    }
    return padRows(rows, height, width)
}

/** Timeline entry with a merged tool outcome (`→ done`) when applicable. */
export interface RenderEntry extends ActivityEntry {
    readonly doneAt?: number
}

/**
 * Merge a `tool X` call with its `X completed` result, and drop an identical
 * message shadowed by its terminal `final` payload. Pure so the timeline stays
 * truthful without showing the same text twice.
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
        if (entry.kind === 'tool_result') {
            const callIndex = matchToolCall(out, entry)
            if (callIndex !== -1) {
                out[callIndex] = { ...out[callIndex]!, doneAt: entry.at }
                continue
            }
            if (/completed\s*$/.test(entry.summary)) continue
        }
        out.push({ ...entry })
    }
    return out
}

/**
 * Find the call a completed result belongs to. Results that carry an id match
 * only that id, so parallel look-alike calls never absorb each other's outcome
 * and completions may arrive out of order; entries without an id keep the
 * name-based fallback.
 */
function matchToolCall(
    out: readonly RenderEntry[],
    result: ActivityEntry
): number {
    if (!/completed\s*$/.test(result.summary)) return -1
    for (let index = out.length - 1; index >= 0; index--) {
        const call = out[index]!
        if (call.kind !== 'tool' || call.doneAt !== undefined) continue
        if (result.toolCallId !== undefined) {
            if (call.toolCallId === result.toolCallId) return index
            continue
        }
        if (
            call.toolCallId === undefined &&
            toolNameOf(call.summary) === toolNameOf(result.summary)
        ) {
            return index
        }
    }
    return -1
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
            const nested = entry.nested ? theme.fg('dim', ' · nested') : ''
            const rows = [
                padLine(
                    `${theme.fg('dim', 'TOOL ·')} ${theme.fg('toolTitle', theme.bold(toolName))}${nested} ${theme.fg('dim', `· ${time}`)}${live}`,
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
            const summary = String(entry.summary)
            const toolName = toolNameOf(summary)
            // The header already names the tool; show only the error text.
            const body = summary.split(' failed: ')[1] ?? summary
            return [
                padLine(
                    `${theme.fg('error', theme.bold('! FAILED'))} ${theme.fg('toolTitle', theme.bold(toolName))} ${theme.fg('dim', `· ${time}`)}`,
                    width
                ),
                ...guttered('error', body),
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
 * `lastActivityAt` is the last signal, not the run start. Label it so a quiet
 * agent reads as quiet and a settled one reads as finished, instead of both
 * reading as an elapsed time.
 */
function silenceLabel(
    agent: Pick<ListedAgent, 'status' | 'waiting' | 'running'>,
    silence: string
): string {
    if (agent.waiting || !silence || silence === 'now') return ''
    return agent.status === 'Running' ? `quiet ${silence}` : `idle ${silence}`
}

function statusGlyph(
    agent: Pick<ListedAgent, 'status' | 'waiting'>,
    theme: Theme
): string {
    if (agent.waiting) return theme.fg('warning', '◐')
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

/** Short display name: `/root/worker/nested` -> `worker/nested`. */
export function shortAgentName(path: string): string {
    const stripped = path.replace(/^\/root\/?/, '')
    return stripped === '' ? '/root' : stripped
}

/** Nesting depth below /root (top-level = 0). */
export function agentDepth(path: string): number {
    const stripped = path.replace(/^\/root\/?/, '').replace(/\/$/, '')
    if (!stripped) return 0
    return stripped.split('/').filter(Boolean).length - 1
}

function renderPlainList(agents: ListedAgent[]): string {
    return agents
        .map(
            (a) =>
                `${a.status === 'Running' ? '●' : a.status === 'Completed' ? '✓' : '○'} ${shortAgentName(a.path as string)} ${a.status}`
        )
        .join('\n')
}
