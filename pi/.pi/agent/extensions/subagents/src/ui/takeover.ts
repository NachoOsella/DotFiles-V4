/**
 * Takeover UI for subagents (rendered from the synchronous SubagentReadModel):
 * - SubagentDashboard: compact centered dialog listing all subagents.
 * - TakeoverView: interactive view of one subagent with an input line
 *   to steer/continue it.
 *
 * Rendering contract: render() returns exactly as many lines as the content
 * needs (the TUI sizes the centered overlay from that), every line must stay
 * within `width`, and the total must never exceed the terminal height.
 */

import type {
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from '@earendil-works/pi-coding-agent'
import type { Component, Focusable, TUI } from '@earendil-works/pi-tui'
import { Input, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import {
    formatElapsed,
    formatModelWithThinking,
    type SubagentSnapshot,
} from '../domain.ts'
import {
    countSubagentStates,
    formatContextUtilization,
    subagentDisplayState,
    type SubagentDisplayState,
} from '../format.ts'
import type { SubagentReadModel } from '../manager.ts'
import { buildTranscriptLines, sanitizeText } from './transcript.ts'

/** Dialog width; clamped by the TUI to the terminal width. */
const OVERLAY_WIDTH = 120
const TRANSCRIPT_SCROLL_STEP = 6
/** Below this width (or row count) both views drop box chrome for plain lines. */
const BORDERLESS_MIN_WIDTH = 12
const BORDERLESS_MIN_ROWS = 6

/** Explicit blocking-question source, derived from mailbox/report state. */
export interface SubagentViewOptions {
    /** Returns true while the subagent waits on a parent decision. */
    readonly hasPendingQuestion?: (id: string) => boolean
}

function questionOf(options?: SubagentViewOptions) {
    return options?.hasPendingQuestion
}

/** Elapsed-time tickers only matter while something can visibly change. */
export function dashboardNeedsTicker(
    subs: ReadonlyArray<Pick<SubagentSnapshot, 'status'>>
): boolean {
    return subs.some((snap) => snap.status === 'running')
}

export function takeoverNeedsTicker(snap: SubagentSnapshot | undefined): boolean {
    if (!snap) return false
    if (snap.status === 'running') return true
    if (snap.liveAssistant?.text.trim() || snap.liveAssistant?.thinking.trim())
        return true
    return snap.liveTools.length > 0
}

function oneLine(text: string) {
    return sanitizeText(text.replace(/\s+/g, ' ')).trim()
}

function configuredKeys(
    keybindings: KeybindingsManager,
    binding: Parameters<KeybindingsManager['getKeys']>[0]
) {
    return keybindings.getKeys(binding).join('/') || 'unbound'
}

function statusGlyph(
    state: SubagentDisplayState,
    theme: Theme
): string {
    switch (state) {
        case 'running':
        case 'needs-answer':
            return theme.fg('warning', '■')
        case 'queued':
        case 'closed':
            return theme.fg('muted', '■')
        case 'done':
            return theme.fg('success', '■')
        case 'failed':
        case 'interrupted':
            return theme.fg('error', '■')
    }
}

function statusWord(
    state: SubagentDisplayState,
    theme: Theme
): string {
    switch (state) {
        case 'running':
            return theme.fg('warning', 'running')
        case 'needs-answer':
            return theme.fg('accent', 'needs answer')
        case 'queued':
            return theme.fg('muted', 'queued')
        case 'done':
            return theme.fg('success', 'done')
        case 'failed':
            return theme.fg('error', 'failed')
        case 'interrupted':
            return theme.fg('error', 'interrupted')
        case 'closed':
            return theme.fg('muted', 'closed')
    }
}

/**
 * A dialog bar line: ╭─ <left label> ─<mid> <right label> ─╮ (or ╰…╯).
 * Labels already carry their own surrounding spaces. The result is exactly
 * `innerWidth + 2` columns wide (never wider); on narrow terminals the right
 * label is dropped before the left one is truncated.
 */
function bar(
    theme: Theme,
    left: '╭' | '╰',
    right: '╮' | '╯',
    leftLabel: string,
    rightLabel: string,
    innerWidth: number
): string {
    const dash = theme.fg('borderMuted', '─')
    // Labels carry their own surrounding spaces; mid restores the exact width
    // (corner + dash + leftLabel + mid + rightLabel + dash + corner).
    const mid =
        innerWidth - visibleWidth(leftLabel) - visibleWidth(rightLabel) - 2
    if (mid >= 1) {
        return (
            theme.fg('border', left) +
            dash +
            leftLabel +
            dash.repeat(mid) +
            rightLabel +
            dash +
            theme.fg('border', right)
        )
    }
    // Not enough room for both labels: keep the left, drop the right.
    const label = truncateToWidth(leftLabel, Math.max(2, innerWidth - 3))
    const fill = Math.max(1, innerWidth - visibleWidth(label) - 1)
    return (
        theme.fg('border', left) +
        dash +
        label +
        dash.repeat(fill) +
        theme.fg('border', right)
    )
}

function terminalRows(tui: TUI): number {
    const rows = tui.terminal.rows ?? 30
    return Number.isFinite(rows) ? Math.floor(rows) : 30
}

/**
 * Final safety net for the rendering contract: no more than `rows` lines and
 * no line wider than `width` (ANSI-aware). Borderless and framed paths build
 * within budget already; this only guards against a miscounted label.
 */
function clampLines(lines: string[], width: number, rows: number): string[] {
    if (width <= 0 || rows <= 0) return []
    const capped = lines.slice(0, Math.max(0, rows))
    let dirty = capped.length !== lines.length
    const out = capped.map((line) => {
        if (visibleWidth(line) <= width) return line
        dirty = true
        return truncateToWidth(line, width)
    })
    void dirty
    return out
}

function useBorderless(width: number, rows: number): boolean {
    return width < BORDERLESS_MIN_WIDTH || rows < BORDERLESS_MIN_ROWS
}

export interface ScrollWindow {
    /** First visible agent index. */
    readonly start: number
    /** Number of visible agent rows. */
    readonly size: number
    /** Agents hidden above the window (own indicator line when > 0). */
    readonly topMore: number
    /** Agents hidden below the window (own indicator line when > 0). */
    readonly bottomMore: number
}

/**
 * Largest scroll window (up to `cap` agent rows) that keeps `selIndex`
 * visible. Scroll indicators are reported separately so callers render them
 * on their own lines instead of replacing selectable agent rows.
 */
export function fitScrollWindow(
    count: number,
    cap: number,
    selIndex: number
): ScrollWindow {
    const sel =
        count === 0 ? 0 : Math.min(Math.max(0, selIndex), count - 1)
    if (cap <= 0 || count === 0)
        return { start: sel, size: 0, topMore: 0, bottomMore: 0 }
    if (count <= cap)
        return { start: 0, size: count, topMore: 0, bottomMore: 0 }
    if (cap === 1)
        return { start: sel, size: 1, topMore: 0, bottomMore: 0 }
    const windowStart = (size: number) =>
        Math.min(Math.max(0, sel - Math.floor(size / 2)), count - size)
    for (let size = cap; size >= 1; size--) {
        const start = windowStart(size)
        const topMore = start
        const bottomMore = count - start - size
        if (size + (topMore > 0 ? 1 : 0) + (bottomMore > 0 ? 1 : 0) <= cap) {
            return { start, size, topMore, bottomMore }
        }
    }
    return { start: sel, size: 1, topMore: 0, bottomMore: 0 }
}

function plainStatusWord(state: SubagentDisplayState): string {
    switch (state) {
        case 'running':
            return 'running'
        case 'needs-answer':
            return 'needs answer'
        case 'queued':
            return 'queued'
        case 'done':
            return 'done'
        case 'failed':
            return 'failed'
        case 'interrupted':
            return 'interrupted'
        case 'closed':
            return 'closed'
    }
}

// --- Entry point ---------------------------------------------------------------

export async function openSubagentPicker(
    ctx: ExtensionCommandContext,
    view: SubagentReadModel,
    options?: SubagentViewOptions
) {
    const selection: DashboardSelection = { index: 0 }

    while (true) {
        if (view.size() === 0) {
            ctx.ui.notify('No subagents', 'info')
            return
        }

        const picked = await ctx.ui.custom<string | null>(
            (tui, theme, keybindings, done) =>
                new SubagentDashboard(
                    tui,
                    theme,
                    keybindings,
                    view,
                    selection,
                    done,
                    options
                ),
            {
                overlay: true,
                overlayOptions: {
                    anchor: 'center',
                    width: OVERLAY_WIDTH,
                    maxHeight: '100%',
                },
            }
        )

        if (!picked) return
        if (!view.get(picked)) continue

        await ctx.ui.custom<null>(
            (tui, theme, keybindings, done) =>
                new TakeoverView(
                    tui,
                    theme,
                    keybindings,
                    picked,
                    view,
                    done,
                    options
                ),
            {
                overlay: true,
                overlayOptions: {
                    anchor: 'center',
                    width: OVERLAY_WIDTH,
                    maxHeight: '100%',
                },
            }
        )
        // After leaving the takeover view, fall back to the dashboard.
    }
}

// --- Dashboard (centered dialog) ----------------------------------------------

export interface DashboardSelection {
    id?: string
    index: number
}

export function reconcileDashboardSelection(
    selection: DashboardSelection,
    subs: ReadonlyArray<Pick<SubagentSnapshot, 'id'>>
) {
    const stableIndex = selection.id
        ? subs.findIndex((snap) => snap.id === selection.id)
        : -1
    selection.index =
        stableIndex >= 0
            ? stableIndex
            : Math.min(
                  Math.max(0, selection.index),
                  Math.max(0, subs.length - 1)
              )
    selection.id = subs[selection.index]?.id
}

export class SubagentDashboard implements Component {
    private tui: TUI
    private theme: Theme
    private keybindings: KeybindingsManager
    private view: SubagentReadModel
    private selection: DashboardSelection
    private done: (value: string | null) => void
    private hasPendingQuestion?: (id: string) => boolean

    private closed = false
    private ticker?: ReturnType<typeof setInterval>
    private unsubChange: () => void

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        view: SubagentReadModel,
        selection: DashboardSelection,
        done: (value: string | null) => void,
        options?: SubagentViewOptions
    ) {
        this.tui = tui
        this.theme = theme
        this.keybindings = keybindings
        this.view = view
        this.selection = selection
        this.done = done
        this.hasPendingQuestion = questionOf(options)
        this.unsubChange = view.subscribe(() => {
            this.syncTicker()
            this.tui.requestRender()
        })
        // Elapsed times tick along at 1Hz only while an agent can change.
        this.syncTicker()
    }

    private syncTicker() {
        const needs = dashboardNeedsTicker(this.subs())
        if (needs && !this.ticker) {
            this.ticker = setInterval(() => this.tui.requestRender(), 1000)
        } else if (!needs && this.ticker) {
            clearInterval(this.ticker)
            this.ticker = undefined
        }
    }

    private subs(): ReadonlyArray<SubagentSnapshot> {
        return this.view.list()
    }

    private cleanup() {
        if (this.closed) return false
        this.closed = true
        if (this.ticker) clearInterval(this.ticker)
        this.ticker = undefined
        this.unsubChange()
        return true
    }

    private close(result: string | null) {
        if (this.cleanup()) this.done(result)
    }

    dispose(): void {
        this.cleanup()
    }

    handleInput(data: string): void {
        const subs = this.subs()
        reconcileDashboardSelection(this.selection, subs)

        if (this.keybindings.matches(data, 'tui.select.cancel')) {
            this.close(null)
            return
        }
        if (this.keybindings.matches(data, 'tui.select.confirm')) {
            const snap = subs[this.selection.index]
            if (snap) this.close(snap.id)
            return
        }
        if (this.keybindings.matches(data, 'tui.select.up')) {
            if (subs.length > 0) {
                this.selection.index =
                    (this.selection.index - 1 + subs.length) % subs.length
                this.selection.id = subs[this.selection.index]?.id
                this.tui.requestRender()
            }
            return
        }
        if (this.keybindings.matches(data, 'tui.select.down')) {
            if (subs.length > 0) {
                this.selection.index = (this.selection.index + 1) % subs.length
                this.selection.id = subs[this.selection.index]?.id
                this.tui.requestRender()
            }
            return
        }
        if (this.keybindings.matches(data, 'app.clear')) {
            const snap = subs[this.selection.index]
            if (snap && snap.status === 'running')
                this.view.requestAbort(snap.id)
            return
        }
    }

    private pad(text: string, width: number): string {
        const truncated = truncateToWidth(text, width)
        return (
            truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)))
        )
    }

    render(width: number): string[] {
        const subs = this.subs()
        reconcileDashboardSelection(this.selection, subs)
        const rows = terminalRows(this.tui)
        if (width <= 0 || rows <= 0) return []
        if (useBorderless(width, rows)) {
            return clampLines(
                this.renderBorderless(subs, width, rows),
                width,
                rows
            )
        }
        return clampLines(this.renderFramed(subs, width, rows), width, rows)
    }

    /** Plain-words status for the borderless fallback (no ANSI, no symbols). */
    private borderlessRow(
        snap: SubagentSnapshot,
        isSelected: boolean,
        width: number
    ): string {
        const state = subagentDisplayState(snap, this.hasPendingQuestion)
        const marker = isSelected ? '>' : ' '
        return truncateToWidth(
            `${marker} ${oneLine(snap.id)} ${oneLine(snap.taskName ?? snap.title)} ${plainStatusWord(state)}`,
            width
        )
    }

    /**
     * Borderless fallback for narrow/short terminals: title, a scroll window
     * that always keeps the selected agent visible, and the cancel hint.
     * Scroll indicators are separate lines, never replacement rows.
     */
    private renderBorderless(
        subs: ReadonlyArray<SubagentSnapshot>,
        width: number,
        rows: number
    ): string[] {
        const theme = this.theme
        if (subs.length === 0) {
            return [
                truncateToWidth('Subagents (0)', width),
                truncateToWidth(theme.fg('dim', 'no subagents'), width),
            ]
        }
        const selected =
            subs[this.selection.index] ?? subs[subs.length - 1]!
        if (rows === 1) return [this.borderlessRow(selected, true, width)]
        const position = `${this.selection.index + 1}/${subs.length}`
        const title =
            visibleWidth(`Subagents (${subs.length}) ${position}`) <= width
                ? `Subagents (${subs.length}) ${position}`
                : visibleWidth(position) <= width
                  ? position
                  : `Subagents (${subs.length})`
        const lines: string[] = [truncateToWidth(title, width)]
        const hint = truncateToWidth(
            `${configuredKeys(this.keybindings, 'tui.select.cancel')} close`,
            width
        )
        const roomForHint = rows >= 3 ? 1 : 0
        const bodyCap = Math.max(0, rows - 1 - roomForHint)
        const win = fitScrollWindow(subs.length, bodyCap, this.selection.index)
        if (win.topMore > 0 && win.size > 0)
            lines.push(
                truncateToWidth(
                    theme.fg('dim', `... ${win.topMore} more`),
                    width
                )
            )
        for (let i = 0; i < win.size; i++) {
            const snap = subs[win.start + i]!
            lines.push(
                this.borderlessRow(
                    snap,
                    win.start + i === this.selection.index,
                    width
                )
            )
        }
        if (win.bottomMore > 0 && win.size > 0)
            lines.push(
                truncateToWidth(
                    theme.fg('dim', `... ${win.bottomMore} more`),
                    width
                )
            )
        if (roomForHint > 0) lines.push(hint)
        return lines
    }

    private renderFramed(
        subs: ReadonlyArray<SubagentSnapshot>,
        width: number,
        rows: number
    ): string[] {
        const theme = this.theme
        const innerWidth = width - 2
        const lines: string[] = []

        // Title bar: ╭─ Subagents ──────────── 5 agents ─╮
        const countLabel = `${subs.length} agent${subs.length === 1 ? '' : 's'}`
        lines.push(
            bar(
                theme,
                '╭',
                '╮',
                ` ${theme.fg('accent', theme.bold('Subagents'))} `,
                ` ${theme.fg('muted', countLabel)} `,
                innerWidth
            )
        )

        // Body budget: title + summary + bottom bar already account for 3 of
        // `rows`; scroll indicators take their own lines outside agent rows.
        const divider = theme.fg('border', '│')
        const framedRow = (content: string) =>
            divider + this.pad(content, innerWidth) + divider
        const bodyCap = Math.max(1, rows - 3)
        const win = fitScrollWindow(subs.length, bodyCap, this.selection.index)
        if (win.topMore > 0)
            lines.push(
                framedRow(theme.fg('dim', `   … ${win.topMore} more`))
            )
        for (let i = 0; i < win.size; i++) {
            const index = win.start + i
            const snap = subs[index]!
            lines.push(
                framedRow(
                    this.rowContent(snap, index === this.selection.index, innerWidth)
                )
            )
        }
        if (win.bottomMore > 0)
            lines.push(
                framedRow(theme.fg('dim', `   … ${win.bottomMore} more`))
            )

        // Status summary with consistent buckets (closed is not failure).
        lines.push(framedRow(` ${this.summaryContent(subs)} `))

        // Bottom bar keeps the cancel/confirm/stop hints (cancel first so it
        // survives truncation) plus a selected-position counter when it fits.
        const hints =
            `${configuredKeys(this.keybindings, 'tui.select.cancel')} close · ` +
            `${configuredKeys(this.keybindings, 'tui.select.confirm')} inspect · ` +
            `${configuredKeys(this.keybindings, 'app.clear')} stop`
        const position =
            subs.length > 0
                ? ` ${this.selection.index + 1}/${subs.length} `
                : ''
        lines.push(
            bar(
                theme,
                '╰',
                '╯',
                theme.fg('dim', ` ${hints} `),
                position ? theme.fg('muted', position) : '',
                innerWidth
            )
        )

        return lines
    }

    private summaryContent(subs: ReadonlyArray<SubagentSnapshot>): string {
        const theme = this.theme
        if (subs.length === 0) return theme.fg('dim', 'no subagents')
        const counts = countSubagentStates(subs, this.hasPendingQuestion)
        const dot = theme.fg('dim', ' · ')
        const parts: string[] = []
        if (counts.running > 0)
            parts.push(theme.fg('warning', `■ ${counts.running} running`))
        if (counts.queued > 0)
            parts.push(theme.fg('muted', `■ ${counts.queued} queued`))
        if (counts.done > 0)
            parts.push(theme.fg('success', `■ ${counts.done} done`))
        if (counts.failed > 0)
            parts.push(theme.fg('error', `■ ${counts.failed} failed`))
        if (counts.interrupted > 0)
            parts.push(
                theme.fg('error', `■ ${counts.interrupted} interrupted`)
            )
        if (counts.closed > 0)
            parts.push(theme.fg('muted', `■ ${counts.closed} closed`))
        // The caller pads/truncates to the available inner width.
        return parts.join(dot)
    }

    /**
     * One agent row within `width`: marker, status, task, then optional
     * metadata (role/id, elapsed, status word) widest-first. Truncation cuts
     * from the right so the selection marker and task start always survive.
     */
    private rowContent(
        snap: SubagentSnapshot,
        isSelected: boolean,
        width: number
    ): string {
        const theme = this.theme
        const state = subagentDisplayState(snap, this.hasPendingQuestion)
        const marker = isSelected ? theme.fg('accent', '❯') : ' '
        const task = oneLine(snap.taskName ?? snap.title)
        const title = isSelected
            ? theme.fg('accent', task)
            : theme.fg('text', task)
        const leftCore = ` ${marker} ${statusGlyph(state, theme)} ${title}`
        const meta = theme.fg(
            'dim',
            `· ${oneLine(snap.role ?? 'default')} · ${oneLine(snap.id)}`
        )
        const word = statusWord(state, theme)
        const fullRight = `${theme.fg('muted', formatElapsed(snap))} ${word}`

        let right = ''
        if (visibleWidth(leftCore) + 1 + visibleWidth(word) <= width) {
            right =
                visibleWidth(leftCore) + 1 + visibleWidth(fullRight) <= width
                    ? fullRight
                    : word
        }
        let left = leftCore
        if (
            visibleWidth(left) + 1 + visibleWidth(meta) +
                (right ? 1 + visibleWidth(right) : 0) <=
            width
        ) {
            left += ` ${meta}`
        }
        if (!right) return truncateToWidth(left, width)
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
        return truncateToWidth(left + ' '.repeat(gap) + right, width)
    }

    invalidate(): void {}
}

// --- Takeover view --------------------------------------------------------------

/**
 * Keep the same transcript lines visible when new output arrives above the
 * tail.
 */
export function preserveScrolledOffset(
    scrollOffset: number,
    previousLineCount: number | undefined,
    nextLineCount: number
): number {
    if (scrollOffset === 0 || previousLineCount === undefined) {
        return scrollOffset
    }
    return Math.max(0, scrollOffset + nextLineCount - previousLineCount)
}

/** Stable cache identity for transcript and live activity rendering. */
export function transcriptCacheKey(
    snap: Pick<SubagentSnapshot, 'id' | 'version' | 'transcriptVersion'>,
    width: number
) {
    return [snap.id, snap.transcriptVersion ?? snap.version ?? 0, width].join(
        '|'
    )
}

export class TakeoverView implements Component, Focusable {
    private tui: TUI
    private theme: Theme
    private keybindings: KeybindingsManager
    private id: string
    private view: SubagentReadModel
    private done: (value: null) => void

    private input = new Input()
    /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
    private scrollOffset = 0
    private previousTranscriptLineCount?: number
    private previousTranscriptWidth?: number
    private hasPendingSnapshotUpdate = false
    /** Fingerprint-keyed transcript lines: streaming re-renders stay cheap. */
    private transcriptKey = ''
    private transcriptLines: string[] = []
    private unsubscribe: () => void
    private renderTimer?: ReturnType<typeof setTimeout>
    private ticker?: ReturnType<typeof setInterval>
    private closed = false
    private hasPendingQuestion?: (id: string) => boolean

    private _focused = false
    get focused(): boolean {
        return this._focused
    }
    set focused(value: boolean) {
        this._focused = value
        this.input.focused = value
    }

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        id: string,
        view: SubagentReadModel,
        done: (value: null) => void,
        options?: SubagentViewOptions
    ) {
        this.tui = tui
        this.theme = theme
        this.keybindings = keybindings
        this.id = id
        this.view = view
        this.done = done
        this.hasPendingQuestion = questionOf(options)
        this.unsubscribe = view.subscribeTo(id, () => {
            this.hasPendingSnapshotUpdate = true
            this.syncTicker()
            this.scheduleRender()
        })
        // Elapsed time in the header ticks at 1Hz only while visible state
        // can change on its own.
        this.syncTicker()
        this.input.onSubmit = (value: string) => {
            const text = value.trim()
            if (!text) return
            this.input.setValue('')
            this.view.requestSend(this.id, text)
            this.scrollOffset = 0
            this.tui.requestRender()
        }
    }

    private snap(): SubagentSnapshot | undefined {
        return this.view.get(this.id)
    }

    private syncTicker() {
        const needs = takeoverNeedsTicker(this.snap())
        if (needs && !this.ticker) {
            this.ticker = setInterval(() => this.tui.requestRender(), 1000)
        } else if (!needs && this.ticker) {
            clearInterval(this.ticker)
            this.ticker = undefined
        }
    }

    private scheduleRender() {
        if (this.renderTimer) return
        // Streaming can emit an event per token. Limit terminal repaints so this
        // view cannot starve input handling or make the child look frozen.
        this.renderTimer = setTimeout(() => {
            this.renderTimer = undefined
            if (!this.closed) this.tui.requestRender()
        }, 50)
    }

    private cleanup() {
        if (this.closed) return false
        this.closed = true
        this.unsubscribe()
        if (this.ticker) clearInterval(this.ticker)
        this.ticker = undefined
        if (this.renderTimer) clearTimeout(this.renderTimer)
        this.renderTimer = undefined
        return true
    }

    private close() {
        if (this.cleanup()) this.done(null)
    }

    dispose(): void {
        this.cleanup()
    }

    private viewportHeight(rows: number): number {
        // Chrome: title bar, details, input row, bottom bar = 4 rows. Leave the
        // terminal footer plus one row of breathing room below the dialog.
        return Math.max(2, rows - 8)
    }

    handleInput(data: string): void {
        if (this.keybindings.matches(data, 'app.clear')) {
            const snap = this.snap()
            if (snap?.status === 'running') this.view.requestAbort(this.id)
            this.syncTicker()
            return
        }
        if (
            this.keybindings.matches(data, 'app.interrupt') ||
            this.keybindings.matches(data, 'tui.select.cancel')
        ) {
            this.close()
            return
        }
        if (this.keybindings.matches(data, 'tui.editor.cursorUp')) {
            this.scrollOffset += TRANSCRIPT_SCROLL_STEP
            this.tui.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.editor.cursorDown')) {
            this.scrollOffset = Math.max(
                0,
                this.scrollOffset - TRANSCRIPT_SCROLL_STEP
            )
            this.tui.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.editor.pageUp')) {
            this.scrollOffset += this.viewportHeight(
                this.tui.terminal.rows ?? 30
            )
            this.tui.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.editor.pageDown')) {
            this.scrollOffset = Math.max(
                0,
                this.scrollOffset -
                    this.viewportHeight(this.tui.terminal.rows ?? 30)
            )
            this.tui.requestRender()
            return
        }
        this.input.handleInput(data)
        this.tui.requestRender()
    }

    /** Cache identity is version-based, never derived from content lengths. */
    private currentTranscriptKey(
        snap: SubagentSnapshot,
        width: number
    ): string {
        return transcriptCacheKey(snap, width)
    }

    private transcript(snap: SubagentSnapshot, width: number): string[] {
        const key = this.currentTranscriptKey(snap, width)
        if (key !== this.transcriptKey) {
            this.transcriptKey = key
            this.transcriptLines = buildTranscriptLines(snap, width, this.theme)
        }
        return this.transcriptLines
    }

    render(width: number): string[] {
        const rows = terminalRows(this.tui)
        if (width <= 0 || rows <= 0) return []
        const snap = this.snap()
        const lines = useBorderless(width, rows)
            ? this.renderBorderless(snap, width, rows)
            : this.renderFramed(snap, width, rows)
        return clampLines(lines, width, rows)
    }

    private renderBorderless(
        snap: SubagentSnapshot | undefined,
        width: number,
        rows: number
    ): string[] {
        if (!snap) {
            return [
                truncateToWidth('Subagent', width),
                truncateToWidth(`${oneLine(this.id)} is no longer tracked`, width),
            ]
        }
        const state = subagentDisplayState(snap, this.hasPendingQuestion)
        const title = truncateToWidth(
            `${oneLine(snap.taskName ?? snap.title)} · ${plainStatusWord(state)}`,
            width
        )
        const inputLine = truncateToWidth(
            this.input.render(width)[0] ?? '',
            width
        )
        const hint = truncateToWidth(
            `${configuredKeys(this.keybindings, 'app.interrupt')} close`,
            width
        )
        if (rows === 1) return [title]
        if (rows === 2) return [title, inputLine]
        if (rows === 3) return [title, inputLine, hint]
        const capacity = rows - 3
        const body = this.bodyLines(snap, width, capacity).map((line) =>
            truncateToWidth(line, width)
        )
        return [title, ...body.slice(0, capacity), inputLine, hint]
    }

    private renderFramed(
        snap: SubagentSnapshot | undefined,
        width: number,
        rows: number
    ): string[] {
        const theme = this.theme
        const innerWidth = width - 2
        const divider = theme.fg('border', '│')
        const lines: string[] = []
        const framed = (content: string) => {
            const clipped = truncateToWidth(
                content,
                Math.max(0, innerWidth - 1)
            )
            return (
                divider +
                ' ' +
                clipped +
                ' '.repeat(
                    Math.max(0, innerWidth - visibleWidth(clipped) - 1)
                ) +
                divider
            )
        }
        const detailLabel = (text: string) => theme.fg('muted', text)

        if (!snap) {
            lines.push(
                bar(
                    theme,
                    '╭',
                    '╮',
                    ` ${theme.fg('accent', theme.bold('Subagent'))} `,
                    '',
                    innerWidth
                )
            )
            lines.push(
                framed(
                    theme.fg(
                        'dim',
                        `${oneLine(this.id)} is no longer tracked`
                    )
                )
            )
            lines.push(bar(theme, '╰', '╯', '', '', innerWidth))
            return lines
        }

        const state = subagentDisplayState(snap, this.hasPendingQuestion)
        // Title bar: ╭─ ■ <task> · <role> · <id> ───── running ─╮
        const titleLabel =
            ` ${statusGlyph(state, theme)} ` +
            theme.fg('text', theme.bold(oneLine(snap.taskName ?? snap.title))) +
            theme.fg(
                'dim',
                ` · ${oneLine(snap.role ?? 'default')} · ${oneLine(snap.id)} `
            )
        lines.push(
            bar(
                theme,
                '╭',
                '╮',
                titleLabel,
                ` ${statusWord(state, theme)} `,
                innerWidth
            )
        )

        // Details: model · context · elapsed · turns (no labels needed)
        const utilization = formatContextUtilization(snap.usage)
        const details: string[] = [
            detailLabel(oneLine(formatModelWithThinking(snap.meta, 'unknown'))),
        ]
        if (utilization) details.push(detailLabel(utilization))
        details.push(detailLabel(formatElapsed(snap)))
        details.push(detailLabel(`${snap.turns} turns`))
        lines.push(framed(details.join(theme.fg('dim', ' · '))))

        // Fixed-height transcript viewport. Error and scroll status consume rows
        // inside the viewport so streaming/scrolling never changes overlay height.
        // Chrome is title + details + input + bottom bar = 4 rows.
        const contentWidth = Math.max(1, innerWidth - 2)
        const viewport = Math.max(0, rows - 4)
        const body = this.bodyLines(snap, contentWidth, viewport)
        while (body.length < viewport) body.push('')
        lines.push(...body.slice(0, viewport).map(framed))

        // Input row (Input draws its own "> " prompt)
        lines.push(framed(this.input.render(contentWidth)[0] ?? ''))

        // Bottom bar keeps the close hint before the stop hint.
        const hints =
            `${configuredKeys(this.keybindings, 'app.interrupt')} close · ` +
            `${configuredKeys(this.keybindings, 'app.clear')} stop`
        lines.push(
            bar(theme, '╰', '╯', theme.fg('dim', ` ${hints} `), '', innerWidth)
        )

        return lines
    }

    /**
     * Transcript tail for a fixed `capacity`: error note, visible slice,
     * waiting placeholder, and the paused-scroll notice. Scroll anchoring
     * (tail-relative offset compensation) is preserved here.
     */
    private bodyLines(
        snap: SubagentSnapshot,
        contentWidth: number,
        capacity: number
    ): string[] {
        const theme = this.theme
        const transcriptLines = this.transcript(snap, contentWidth)
        // The offset is tail-relative. Compensate for appended streamed lines so a
        // reader who scrolled up stays on the exact output they were inspecting.
        if (
            this.hasPendingSnapshotUpdate &&
            this.previousTranscriptWidth === contentWidth
        ) {
            this.scrollOffset = preserveScrolledOffset(
                this.scrollOffset,
                this.previousTranscriptLineCount,
                transcriptLines.length
            )
        }
        this.previousTranscriptLineCount = transcriptLines.length
        this.previousTranscriptWidth = contentWidth
        this.hasPendingSnapshotUpdate = false

        const noteRows: string[] = []
        if (snap.errorText) {
            noteRows.push(
                truncateToWidth(
                    theme.fg('error', '✗ ') +
                        theme.fg('error', oneLine(snap.errorText)),
                    contentWidth
                )
            )
        }

        const body: string[] = [...noteRows]
        const paused = this.scrollOffset > 0
        const visibleCap = Math.max(
            0,
            capacity - body.length - (paused ? 1 : 0)
        )
        const maxOffset = Math.max(0, transcriptLines.length - visibleCap)
        if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset

        const end = transcriptLines.length - this.scrollOffset
        const visible = transcriptLines.slice(
            Math.max(0, end - visibleCap),
            end
        )
        if (visible.length === 0 && capacity > body.length + (paused ? 1 : 0)) {
            body.push(
                theme.fg('warning', '◌ ') +
                    theme.fg('dim', 'waiting for activity')
            )
        } else {
            body.push(...visible)
        }

        if (paused) {
            body.push(
                truncateToWidth(
                    theme.fg('warning', '↑ paused ') +
                        theme.fg(
                            'dim',
                            `· ${this.scrollOffset} newer · ` +
                                `${configuredKeys(this.keybindings, 'tui.editor.cursorDown')}/` +
                                `${configuredKeys(this.keybindings, 'tui.editor.pageDown')} to follow`
                        ),
                    contentWidth
                )
            )
        }
        return body.slice(0, Math.max(0, capacity))
    }

    invalidate(): void {
        // Drop cached transcript lines so the next render rebuilds with the
        // current theme (the key mismatch forces the rebuild).
        this.transcriptKey = ''
        this.input.invalidate()
    }
}
