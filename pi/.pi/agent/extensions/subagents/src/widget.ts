/**
 * Subagent widget: stats-styled mini panel, collapsible to one line.
 * Compact shows a single ambient count; expanded mirrors the session-stats
 * dashboard frame (accent title, muted scope, dim footer hint).
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { AgentPath } from './ids.ts'
import type { ListedAgent, SubagentManager } from './manager.ts'

const WIDGET_KEY = 'subagents'
const MAX_VISIBLE_AGENTS = 5

let detailed = false
let collapsed = false

/** Switch expanded rows between compact and detailed. */
export function setSubagentsWidgetDetail(value: boolean): void {
    detailed = value
}

/** Current expanded-row density (compact by default). */
export function isSubagentsWidgetDetailed(): boolean {
    return detailed
}

/** Collapsed mode renders a single ambient line (toggled with alt+s). */
export function setWidgetCollapsed(value: boolean): void {
    collapsed = value
}

/** Whether the widget renders collapsed. */
export function isWidgetCollapsed(): boolean {
    return collapsed
}

/** Flip collapsed mode; returns the new state. */
export function toggleWidgetCollapsed(): boolean {
    collapsed = !collapsed
    return collapsed
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

/**
 * Single-line summary text; the caller colors it with compactTone.
 * Priority: running beats errored beats settled.
 */
export function compactSummary(
    active: number,
    errored: number,
    total: number
): string {
    if (active > 0) return `● ${active} running`
    if (errored > 0) return `! ${errored} errored`
    return `✓ ${total} settled`
}

/** Theme token for the compact line: one accent dominates. */
export function compactTone(
    active: number,
    errored: number
): 'accent' | 'warning' | 'muted' {
    if (active > 0) return 'accent'
    if (errored > 0) return 'warning'
    return 'muted'
}

function statusText(agent: Pick<ListedAgent, 'status'>): string {
    return agent.status === 'PendingInit' ? 'Starting' : agent.status
}

function statusGlyph(agent: Pick<ListedAgent, 'status'>, theme: Theme): string {
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

/**
 * Stats-style expanded panel. Every returned line fits `width`
 * (ANSI-aware); plain-text math first, styling last.
 */
const MAX_NAME_CHARS = 28

export function buildExpandedLines(
    agents: readonly ListedAgent[],
    theme: Theme,
    width: number,
    showDetail: boolean
): string[] {
    const active = agents.filter((agent) => agent.status === 'Running').length
    const scopeText =
        active > 0 ? `${active} active` : `${agents.length} settled`

    // One row per top-level agent; nested descendants collapse into a
    // `+N · ●M` indicator (total nested · nested running).
    const tops = agents.filter(
        (agent) => (agent.parentPath as string) === '/root'
    )
    const visible = tops.slice(0, MAX_VISIBLE_AGENTS)
    const statusCol = Math.max(
        1,
        ...visible.map((agent) => statusText(agent).length)
    )
    const morePlain =
        tops.length > MAX_VISIBLE_AGENTS
            ? `+${tops.length - MAX_VISIBLE_AGENTS} more (/agents)`
            : ''
    // Size the frame to the content instead of the terminal width.
    const contentMax = Math.max(
        visibleWidth('AGENTS') + 1 + visibleWidth(scopeText),
        visibleWidth(morePlain),
        ...visible.map(
            (agent) =>
                2 +
                visibleWidth(
                    truncateToWidth(
                        shortAgentName(agent.path as string),
                        MAX_NAME_CHARS,
                        '…',
                        false
                    )
                ) +
                nestedIndicatorPlain(agents, agent).length +
                detailPlainFor(agent, showDetail).length +
                1 +
                statusCol
        )
    )
    const frameWidth = Math.min(
        Math.max(20, width),
        Math.max(20, contentMax + 4)
    )
    const inner = frameWidth - 2
    const border = (text: string) => theme.fg('border', text)
    const lines: string[] = [theme.fg('borderAccent', `╭${'─'.repeat(inner)}╮`)]

    const gap = Math.max(
        1,
        inner - visibleWidth('AGENTS') - visibleWidth(scopeText) - 2
    )
    lines.push(
        truncateToWidth(
            `${border('│')} ${theme.fg('accent', 'AGENTS')}${' '.repeat(gap)}${theme.fg('muted', scopeText)} ${border('│')}`,
            frameWidth,
            '',
            false
        )
    )

    for (const agent of visible) {
        const indicator = descendantIndicator(agents, agent, theme)
        const detailPlain = detailPlainFor(agent, showDetail)
        const nameBudget = Math.max(
            4,
            Math.min(
                MAX_NAME_CHARS,
                inner -
                    2 -
                    2 -
                    statusCol -
                    1 -
                    indicator.plain.length -
                    detailPlain.length
            )
        )
        const name = truncateToWidth(
            shortAgentName(agent.path as string),
            nameBudget,
            '…',
            false
        )
        const detail = detailPlain ? theme.fg('dim', detailPlain) : ''
        const left = `${statusGlyph(agent, theme)} ${theme.fg('text', name)}${indicator.styled}${detail}`
        const rowGap = Math.max(1, inner - 2 - visibleWidth(left) - statusCol)
        lines.push(
            truncateToWidth(
                `${border('│')} ${left}${' '.repeat(rowGap)}${theme.fg('muted', statusText(agent).padStart(statusCol))} ${border('│')}`,
                frameWidth,
                '',
                false
            )
        )
    }

    if (tops.length > MAX_VISIBLE_AGENTS) {
        const more = theme.fg(
            'dim',
            `+${tops.length - MAX_VISIBLE_AGENTS} more (/agents)`
        )
        const padding = Math.max(0, inner - 2 - visibleWidth(more))
        lines.push(
            truncateToWidth(
                `${border('│')} ${more}${' '.repeat(padding)} ${border('│')}`,
                frameWidth,
                '',
                false
            )
        )
    }

    lines.push(theme.fg('borderAccent', `╰${'─'.repeat(inner)}╯`))
    return lines
}

function detailPlainFor(agent: ListedAgent, showDetail: boolean): string {
    return (
        (showDetail && agent.model !== 'root' ? ` ${agent.model}` : '') +
        (agent.hasPendingMail ? ' ✉' : '')
    )
}

function nestedIndicatorPlain(
    agents: readonly ListedAgent[],
    top: ListedAgent
): string {
    const prefix = `${top.path as string}/`
    const nested = agents.filter((agent) =>
        (agent.path as string).startsWith(prefix)
    )
    if (nested.length === 0) return ''
    const running = nested.filter((agent) => agent.status === 'Running').length
    return running === 0
        ? ` +${nested.length}`
        : ` +${nested.length} · ●${running}`
}

/**
 * Collapsed nested-descendant indicator for one top-level row.
 * `plain` mirrors `styled` widths for budget math.
 */
function descendantIndicator(
    agents: readonly ListedAgent[],
    top: ListedAgent,
    theme: Theme
): { plain: string; styled: string } {
    const prefix = `${top.path as string}/`
    const nested = agents.filter((agent) =>
        (agent.path as string).startsWith(prefix)
    )
    if (nested.length === 0) return { plain: '', styled: '' }
    const running = nested.filter((agent) => agent.status === 'Running').length
    if (running === 0) {
        return {
            plain: ` +${nested.length}`,
            styled: theme.fg('dim', ` +${nested.length}`),
        }
    }
    return {
        plain: ` +${nested.length} · ●${running}`,
        styled: `${theme.fg('dim', ` +${nested.length} ·`)}${theme.fg('accent', ` ●${running}`)}`,
    }
}

export function refreshSubagentsWidget(
    ctx: ExtensionContext,
    manager: SubagentManager
): void {
    if (ctx.mode !== 'tui' || !ctx.hasUI) {
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
        } catch {
            // UI may be unavailable.
        }
        return
    }
    const agents = manager.list('/root' as AgentPath)
    if (agents.length === 0) {
        try {
            ctx.ui.setWidget(WIDGET_KEY, undefined)
        } catch {
            // Ignore teardown races.
        }
        return
    }
    try {
        if (collapsed) {
            const active = agents.filter(
                (agent) => agent.status === 'Running'
            ).length
            const errored = agents.filter(
                (agent) => agent.status === 'Errored'
            ).length
            const tone = compactTone(active, errored)
            const text = compactSummary(active, errored, agents.length)
            ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
                render(width: number): string[] {
                    return [
                        truncateToWidth(
                            theme.fg(tone, text),
                            Math.max(1, width),
                            '',
                            false
                        ),
                    ]
                },
                invalidate(): void {},
            }))
            return
        }
        const showDetail = detailed
        ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
            render(width: number): string[] {
                return buildExpandedLines(
                    agents,
                    theme,
                    Math.max(20, width),
                    showDetail
                )
            },
            invalidate(): void {},
        }))
    } catch {
        // Ignore UI races during teardown.
    }
}

export function clearSubagentsWidget(ctx: ExtensionContext): void {
    try {
        ctx.ui.setWidget(WIDGET_KEY, undefined)
    } catch {
        // Ignore teardown races.
    }
}
