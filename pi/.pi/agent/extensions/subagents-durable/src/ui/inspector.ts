/**
 * Read-only pi-tui inspector for the native subagent tree.
 *
 * The component renders a projection and an optional activity feed. It never
 * mutates agents, aborts work, or sends messages. Mounting is a generic
 * callback: the native host decides how to present the component (`ctx.ui.custom`,
 * an overlay, or a test harness). There is no CLI `/agents` registration here.
 *
 * A host that owns a TUI passes `requestRender` so asynchronous projection and
 * activity updates redraw; `invalidate()` alone only clears the render cache.
 */

import type { Component, Focusable } from '@earendil-works/pi-tui'
import {
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from '@earendil-works/pi-tui'
import {
    agentTree,
    formatTokens,
    totalCost,
    totalTokens,
    type AgentStatus,
    type AgentSummary,
    type AgentTree,
    type SubagentProjection,
    type SubagentProjectionSource,
} from './projection.js'

/** Theme tokens the inspector uses; a real Pi theme is structurally compatible. */
export type InspectorToken =
    | 'accent'
    | 'muted'
    | 'dim'
    | 'success'
    | 'error'
    | 'warning'
    | 'border'
    | 'text'
    | 'toolTitle'

export interface InspectorTheme {
    fg(token: InspectorToken, text: string): string
    bold(text: string): string
}

export interface SubagentInspectorOptions {
    /** Called when the inspector closes itself. */
    readonly onClose?: () => void
    /** Repaint the host surface after an async or input-driven state change. */
    readonly requestRender?: () => void
    /** Visible agent rows in list view. Default 12. */
    readonly maxVisible?: number
    /** Visible activity lines in detail view. Default 8. */
    readonly maxActivity?: number
}

export interface SubagentInspectorHandle {
    readonly component: Component
    /** Resolves when the inspector closes. */
    readonly closed: Promise<void>
    dispose(): void
}

const STATUS_GLYPH: Record<AgentStatus, string> = {
    running: '●',
    waiting: '◐',
    idle: '○',
    completed: '✓',
    errored: '!',
    interrupted: '◌',
    unknown: '·',
}

const STATUS_TOKEN: Record<AgentStatus, InspectorToken> = {
    running: 'accent',
    waiting: 'warning',
    idle: 'dim',
    completed: 'success',
    errored: 'error',
    interrupted: 'warning',
    unknown: 'dim',
}

class SubagentInspector implements Component, Focusable {
    focused = false
    readonly closed: Promise<void>

    readonly #source: SubagentProjectionSource
    readonly #theme: InspectorTheme
    readonly #options: SubagentInspectorOptions
    readonly #unsubscribe: () => void
    #resolveClosed!: () => void
    #disposed = false
    #projection: SubagentProjection
    #view: 'list' | 'detail' = 'list'
    #selected = 0
    #offset = 0
    #detail: AgentSummary | undefined
    #activity: readonly string[] = []
    #activityError: string | undefined
    #activityDispose: (() => void) | undefined
    #activityToken = 0
    #cachedWidth: number | undefined
    #cachedLines: string[] | undefined

    constructor(
        source: SubagentProjectionSource,
        theme: InspectorTheme,
        options: SubagentInspectorOptions = {}
    ) {
        this.#source = source
        this.#theme = theme
        this.#options = options
        this.#projection = source.read()
        this.#unsubscribe = source.subscribe((projection) => {
            this.#projection = projection
            if (this.#view === 'detail' && this.#detail !== undefined) {
                this.#detail =
                    projection.agents.find(
                        (agent) => agent.path === this.#detail?.path
                    ) ?? this.#detail
            }
            this.#clampSelection()
            this.#changed()
        })
        this.closed = new Promise<void>((resolve) => {
            this.#resolveClosed = resolve
        })
    }

    render(width: number): string[] {
        if (this.#cachedLines !== undefined && this.#cachedWidth === width)
            return this.#cachedLines
        const lines =
            this.#view === 'detail' && this.#detail !== undefined
                ? this.#renderDetail(width, this.#detail)
                : this.#renderList(width)
        this.#cachedWidth = width
        this.#cachedLines = lines
        return lines
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.pageDown)) this.#move(this.#pageSize())
        else if (matchesKey(data, Key.pageUp)) this.#move(-this.#pageSize())
        else if (matchesKey(data, Key.down) || data === 'j') this.#move(1)
        else if (matchesKey(data, Key.up) || data === 'k') this.#move(-1)
        else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right))
            this.#openSelected()
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.left))
            this.#back()
        else if (data === 'r') this.#refresh()
        else if (data === 'q') this.#close()
        else if (matchesKey(data, Key.home))
            this.#move(-Number.MAX_SAFE_INTEGER)
        else if (matchesKey(data, Key.end)) this.#move(Number.MAX_SAFE_INTEGER)
    }

    invalidate(): void {
        this.#cachedWidth = undefined
        this.#cachedLines = undefined
    }

    dispose(): void {
        if (this.#disposed) return
        this.#disposed = true
        this.#unsubscribe()
        this.#disposeActivity()
        this.#resolveClosed()
    }

    #changed(): void {
        this.invalidate()
        this.#options.requestRender?.()
    }

    #refresh(): void {
        this.#projection = this.#source.read()
        this.#clampSelection()
        this.#changed()
    }

    #close(): void {
        this.#options.onClose?.()
        this.dispose()
    }

    #back(): void {
        if (this.#view === 'list') {
            this.#close()
            return
        }
        this.#view = 'list'
        this.#disposeActivity()
        this.#changed()
    }

    #openSelected(): void {
        const agent = this.#flat()[this.#selected]?.agent
        if (agent === undefined) return
        this.#view = 'detail'
        this.#detail = agent
        this.#offset = 0
        void this.#loadActivity(agent)
        this.#changed()
    }

    #move(delta: number): void {
        if (this.#view === 'detail') {
            this.#offset = clamp(this.#offset + delta, 0, this.#maxOffset())
            this.#changed()
            return
        }
        const total = this.#flat().length
        if (total === 0) return
        this.#selected = Math.min(
            total - 1,
            Math.max(0, this.#selected + delta)
        )
        const visible = this.#pageSize()
        if (this.#selected < this.#offset) this.#offset = this.#selected
        else if (this.#selected >= this.#offset + visible)
            this.#offset = this.#selected - visible + 1
        this.#changed()
    }

    #pageSize(): number {
        return Math.max(1, this.#options.maxVisible ?? 12)
    }

    #activitySize(): number {
        return Math.max(1, this.#options.maxActivity ?? 8)
    }

    #maxOffset(): number {
        return Math.max(0, this.#activity.length - this.#activitySize())
    }

    #clampSelection(): void {
        const total = this.#flat().length
        this.#selected =
            total === 0 ? 0 : Math.min(total - 1, Math.max(0, this.#selected))
    }

    #flat(): readonly {
        readonly agent: AgentSummary
        readonly depth: number
    }[] {
        const rows: { agent: AgentSummary; depth: number }[] = []
        const walk = (nodes: readonly AgentTree[], depth: number): void => {
            for (const node of nodes) {
                rows.push({ agent: node.agent, depth })
                walk(node.children, depth + 1)
            }
        }
        walk(agentTree(this.#projection.agents), 0)
        return rows
    }

    async #loadActivity(agent: AgentSummary): Promise<void> {
        this.#disposeActivity()
        const token = ++this.#activityToken
        this.#activity = []
        this.#activityError = undefined
        this.#changed()
        if (this.#source.watchActivity !== undefined) {
            this.#activityDispose = this.#source.watchActivity(
                agent.conversationId,
                (lines) => {
                    if (token !== this.#activityToken) return
                    this.#activity = lines
                    this.#offset = Math.min(this.#offset, this.#maxOffset())
                    this.#changed()
                }
            )
        }
        if (this.#source.activity === undefined) return
        try {
            const lines = await this.#source.activity(agent.conversationId)
            if (token !== this.#activityToken) return
            this.#activity = lines
        } catch (error) {
            if (token !== this.#activityToken) return
            this.#activityError =
                error instanceof Error ? error.message : String(error)
        }
        this.#offset = Math.min(this.#offset, this.#maxOffset())
        this.#changed()
    }

    #disposeActivity(): void {
        this.#activityDispose?.()
        this.#activityDispose = undefined
        this.#activityToken += 1
    }

    #renderList(width: number): string[] {
        const theme = this.#theme
        const rows = this.#flat()
        const page = this.#pageSize()
        const start = Math.min(this.#offset, Math.max(0, rows.length - page))
        const end = Math.min(start + page, rows.length)
        const lines: string[] = []
        lines.push(this.#header(width, 'Subagents'))
        if (rows.length === 0) {
            lines.push(
                this.#row(width, theme.fg('dim', 'no children registered'))
            )
        }
        for (let index = start; index < end; index++) {
            const row = rows[index]!
            const selected = index === this.#selected
            const marker = selected
                ? theme.fg('accent', '▸')
                : theme.fg('dim', ' ')
            const status = theme.fg(
                STATUS_TOKEN[row.agent.status],
                STATUS_GLYPH[row.agent.status]
            )
            const indent = '  '.repeat(row.depth)
            const name = theme.fg(selected ? 'accent' : 'text', row.agent.name)
            lines.push(
                this.#row(
                    width,
                    `${marker} ${indent}${status} ${name}${this.#meta(row.agent)}`
                )
            )
        }
        if (rows.length > page) {
            lines.push(
                this.#row(
                    width,
                    theme.fg(
                        'dim',
                        `${Math.min(this.#selected + 1, rows.length)}/${rows.length}`
                    )
                )
            )
        }
        lines.push(
            this.#footer(width, '↑↓ move · enter inspect · r refresh · q close')
        )
        return lines
    }

    #renderDetail(width: number, agent: AgentSummary): string[] {
        const theme = this.#theme
        const lines: string[] = []
        lines.push(this.#header(width, agent.name))
        const details = [
            `path      ${agent.path}`,
            `parent    ${agent.parentPath ?? '/root'}`,
            `status    ${agent.status}`,
            `role      ${agent.role ?? '-'}`,
            `model     ${agent.model ?? '-'}`,
            `thinking  ${agent.thinkingLevel ?? '-'}`,
            `tokens    ${formatTokens(totalTokens(agent.usage))}`,
            `cost      $${totalCost(agent.usage).toFixed(4)}`,
            `conv      ${agent.conversationId}`,
        ]
        for (const detail of details)
            lines.push(this.#row(width, theme.fg('muted', detail)))
        if (agent.lastAnswer !== undefined) {
            lines.push(
                this.#row(
                    width,
                    theme.fg('muted', `answer    ${agent.lastAnswer}`)
                )
            )
        }
        const nodes = Object.values(this.#projection.taskGraph.tasks).filter(
            (node) => node.conversationId === agent.conversationId
        )
        if (nodes.length > 0) {
            lines.push(this.#row(width, theme.fg('toolTitle', 'tasks')))
            for (const node of nodes) {
                const phase =
                    'phase' in node.state ? ` ${node.state.phase}` : ''
                lines.push(
                    this.#row(
                        width,
                        theme.fg(
                            'dim',
                            `  ${node.kind} ${node.state.status}${phase}${node.background ? ' bg' : ''}`
                        )
                    )
                )
            }
        }
        lines.push(this.#row(width, theme.fg('toolTitle', 'activity')))
        if (this.#activityError !== undefined) {
            lines.push(this.#row(width, theme.fg('error', this.#activityError)))
        } else if (this.#activity.length === 0) {
            lines.push(this.#row(width, theme.fg('dim', 'no recent activity')))
        } else {
            const size = this.#activitySize()
            const start = Math.min(this.#offset, this.#maxOffset())
            const end = Math.min(start + size, this.#activity.length)
            for (const line of this.#activity.slice(start, end)) {
                lines.push(this.#row(width, theme.fg('muted', line)))
            }
            if (this.#activity.length > size) {
                lines.push(
                    this.#row(
                        width,
                        theme.fg(
                            'dim',
                            `${start + 1}-${end}/${this.#activity.length}`
                        )
                    )
                )
            }
        }
        lines.push(
            this.#footer(width, '↑↓ scroll · esc back · r refresh · q close')
        )
        return lines
    }

    #meta(agent: AgentSummary): string {
        const theme = this.#theme
        const parts: string[] = []
        if (agent.role !== undefined) parts.push(theme.fg('dim', agent.role))
        if (agent.model !== undefined) parts.push(theme.fg('dim', agent.model))
        const tokens = totalTokens(agent.usage)
        if (tokens > 0) parts.push(theme.fg('dim', formatTokens(tokens)))
        return parts.length === 0
            ? ''
            : ` ${theme.fg('dim', '·')} ${parts.join(` ${theme.fg('dim', '·')} `)}`
    }

    #header(width: number, title: string): string {
        const theme = this.#theme
        const counts = this.#projection.counts
        const right = theme.fg(
            'dim',
            `${counts.running} running · ${counts.waiting} waiting · ${counts.total} total`
        )
        const label = theme.fg('accent', theme.bold(title))
        const inner = Math.max(1, width - 4)
        const gap = Math.max(
            1,
            inner - visibleWidth(label) - visibleWidth(right)
        )
        return truncateToWidth(`  ${label}${' '.repeat(gap)}${right}`, width)
    }

    #footer(width: number, hint: string): string {
        return truncateToWidth(this.#theme.fg('dim', `  ${hint}`), width)
    }

    #row(width: number, content: string): string {
        return truncateToWidth(`  ${content}`, width)
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

/** Create a read-only inspector component plus its disposal handle. */
export function createSubagentInspector(
    source: SubagentProjectionSource,
    theme: InspectorTheme,
    options: SubagentInspectorOptions = {}
): SubagentInspectorHandle {
    const inspector = new SubagentInspector(source, theme, options)
    return {
        component: inspector,
        closed: inspector.closed,
        dispose: () => inspector.dispose(),
    }
}

/**
 * Present the inspector through a caller-supplied mount callback and dispose it
 * afterwards. The callback owns presentation: `ctx.ui.custom` in a Pi session,
 * an overlay, or a test double.
 */
export async function mountSubagentInspector(
    present: (component: Component) => void | Promise<void>,
    source: SubagentProjectionSource,
    theme: InspectorTheme,
    options: SubagentInspectorOptions = {}
): Promise<void> {
    const handle = createSubagentInspector(source, theme, options)
    try {
        await present(handle.component)
    } finally {
        handle.dispose()
    }
}

export type { AgentSummary, SubagentProjection, SubagentProjectionSource }
