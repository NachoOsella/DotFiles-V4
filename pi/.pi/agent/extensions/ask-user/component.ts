import {
    Editor,
    type EditorTheme,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { Component, Focusable, TUI } from '@earendil-works/pi-tui'
import {
    QuestionnaireState,
    type StateQuestion,
    type StoredAnswer,
} from './state.ts'

type SelectionResult = StoredAnswer[] | null

interface KeybindingsLike {
    matches(data: string, binding: string): boolean
    getKeys(binding: string): string[]
}

interface ThemeLike {
    fg(color: string, text: string): string
    bold(text: string): string
}

function firstKey(keys: string[] | undefined): string | undefined {
    return keys && keys.length > 0 ? keys[0] : undefined
}

function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
    const prefixWidth = visibleWidth(prefix)
    if (width <= 0) return []
    if (prefixWidth >= width) {
        return wrapTextWithAnsi(prefix + text, width)
    }
    const wrapped = wrapTextWithAnsi(text, width - prefixWidth)
    const continuation = ' '.repeat(prefixWidth)
    return wrapped.map((line, index) =>
        index === 0 ? `${prefix}${line}` : `${continuation}${line}`
    )
}

/** Focusable questionnaire view with width/state-keyed render cache. */
export class QuestionnaireComponent implements Component, Focusable {
    private tui: TUI
    private theme: ThemeLike
    private keybindings: KeybindingsLike
    private done: (result: SelectionResult) => void
    readonly state: QuestionnaireState
    private editor: Editor
    private settled = false
    private scrollOffset = 0
    private cachedWidth: number | undefined
    private cachedKey: string | undefined
    private cachedLines: string[] | undefined
    private _focused = false

    constructor(
        tui: TUI,
        theme: ThemeLike,
        keybindings: KeybindingsLike,
        questions: StateQuestion[],
        done: (result: SelectionResult) => void
    ) {
        this.tui = tui
        this.theme = theme
        this.keybindings = keybindings
        this.done = done
        this.state = new QuestionnaireState(questions)
        const editorTheme: EditorTheme = {
            borderColor: (text) =>
                (this.theme as { fg(c: string, t: string): string }).fg(
                    'accent',
                    text
                ),
            selectList: {
                selectedPrefix: (text) =>
                    (this.theme as { fg(c: string, t: string): string }).fg(
                        'accent',
                        text
                    ),
                selectedText: (text) =>
                    (this.theme as { fg(c: string, t: string): string }).fg(
                        'accent',
                        text
                    ),
                description: (text) =>
                    (this.theme as { fg(c: string, t: string): string }).fg(
                        'muted',
                        text
                    ),
                scrollInfo: (text) =>
                    (this.theme as { fg(c: string, t: string): string }).fg(
                        'dim',
                        text
                    ),
                noMatch: (text) =>
                    (this.theme as { fg(c: string, t: string): string }).fg(
                        'warning',
                        text
                    ),
            },
        }
        this.editor = new Editor(tui, editorTheme)
        this.editor.onSubmit = (value) => {
            if (this.settled) return
            const outcome = this.state.submitCustom(value)
            this.editor.setText('')
            this.scrollOffset = 0
            this.syncEditorFocus()
            this.cachedLines = undefined
            if (outcome.finished) {
                this.settle(outcome.answers)
                return
            }
            this.tui.requestRender()
        }
        this.syncEditorFocus()
    }

    get focused(): boolean {
        return this._focused
    }

    set focused(value: boolean) {
        this._focused = value
        this.syncEditorFocus()
        this.cachedLines = undefined
    }

    private syncEditorFocus(): void {
        this.editor.focused = this._focused && this.state.editMode
    }

    private requestRender(): void {
        this.cachedLines = undefined
        this.tui.requestRender()
    }

    private settle(result: SelectionResult): void {
        if (this.settled) return
        this.settled = true
        this.cachedLines = undefined
        this.done(result)
    }

    /** Idempotent abort entry point for host abort signals. */
    abort(): void {
        this.settle(null)
    }

    /** Idempotent dismissal entry point for Escape. */
    dismiss(): void {
        this.settle(null)
    }

    getEditorText(): string {
        return this.editor.getText()
    }

    handleInput(data: string): void {
        if (this.settled) return
        if (this.state.editMode) {
            if (this.keybindings.matches(data, 'tui.select.cancel')) {
                this.state.cancelEdit()
                this.editor.setText('')
                this.syncEditorFocus()
                this.requestRender()
                return
            }
            this.editor.handleInput(data)
            this.syncEditorFocus()
            this.requestRender()
            return
        }

        const options = this.state.currentOptions()
        if (this.keybindings.matches(data, 'tui.select.up')) {
            this.state.moveSelection(-1)
            this.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.select.down')) {
            this.state.moveSelection(1)
            this.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.select.pageUp')) {
            this.state.moveSelection(-5)
            this.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.select.pageDown')) {
            this.state.moveSelection(5)
            this.requestRender()
            return
        }
        if (this.keybindings.matches(data, 'tui.editor.cursorLeft')) {
            if (this.state.moveQuestion(-1)) {
                this.editor.setText('')
                this.scrollOffset = 0
                this.syncEditorFocus()
                this.requestRender()
            }
            return
        }
        if (this.keybindings.matches(data, 'tui.editor.cursorRight')) {
            if (this.state.moveQuestion(1)) {
                this.editor.setText('')
                this.scrollOffset = 0
                this.syncEditorFocus()
                this.requestRender()
            }
            return
        }
        if (
            data.length === 1 &&
            data >= '1' &&
            data <= String(options.length)
        ) {
            this.choose(Number(data) - 1)
            return
        }
        if (this.keybindings.matches(data, 'tui.select.confirm')) {
            this.choose(this.state.optionIndex)
            return
        }
        if (this.keybindings.matches(data, 'tui.select.cancel')) {
            this.dismiss()
        }
    }

    private choose(index: number): void {
        const outcome = this.state.selectOption(index)
        if ('editing' in outcome) {
            this.syncEditorFocus()
            this.requestRender()
            return
        }
        this.editor.setText('')
        this.scrollOffset = 0
        this.syncEditorFocus()
        if (outcome.finished) {
            this.cachedLines = undefined
            this.settle(outcome.answers)
            return
        }
        this.requestRender()
    }

    invalidate(): void {
        this.cachedLines = undefined
        this.cachedKey = undefined
        this.cachedWidth = undefined
        this.editor.invalidate()
    }

    dispose(): void {
        // No timers owned; host disposes after settle. Keep idempotent.
    }

    private hintText(): string {
        if (this.state.editMode) {
            const submit =
                firstKey(this.keybindings.getKeys('tui.input.submit')) ??
                'enter'
            const back =
                firstKey(this.keybindings.getKeys('tui.select.cancel')) ?? 'esc'
            return `${submit} submit - ${back} back`
        }
        const parts: string[] = []
        const up = firstKey(this.keybindings.getKeys('tui.select.up'))
        const down = firstKey(this.keybindings.getKeys('tui.select.down'))
        if (up && down) parts.push(`${up}/${down} move`)
        else if (up ?? down) parts.push(`${up ?? down} move`)
        const count = this.state.currentOptions().length
        parts.push(`1-${count} choose`)
        const confirm = firstKey(this.keybindings.getKeys('tui.select.confirm'))
        if (confirm) parts.push(`${confirm} select`)
        if (this.state.questions.length > 1) {
            const left = firstKey(
                this.keybindings.getKeys('tui.editor.cursorLeft')
            )
            const right = firstKey(
                this.keybindings.getKeys('tui.editor.cursorRight')
            )
            const canLeft = this.state.questionIndex > 0
            const canRight =
                this.state.questionIndex < this.state.questions.length - 1
            if (canLeft && canRight && left && right) {
                parts.push(`${left}/${right} questions`)
            } else if (canLeft && left) {
                parts.push(`${left} prev`)
            } else if (canRight && right) {
                parts.push(`${right} next`)
            }
        }
        const cancel = firstKey(this.keybindings.getKeys('tui.select.cancel'))
        if (cancel) parts.push(`${cancel} dismiss`)
        return parts.join(' - ')
    }

    render(width: number): string[] {
        const safeWidth = Math.floor(width)
        if (!Number.isFinite(safeWidth) || safeWidth <= 0) return []
        const renderWidth = Math.max(1, safeWidth)
        const cacheKey = [
            this.state.version,
            this.state.questionIndex,
            this.state.optionIndex,
            this.state.editMode ? 1 : 0,
            this.editor.getText(),
            this.scrollOffset,
            this._focused ? 1 : 0,
            this.settled ? 1 : 0,
        ].join('|')
        if (
            this.cachedLines &&
            this.cachedWidth === renderWidth &&
            this.cachedKey === cacheKey
        ) {
            return this.cachedLines
        }

        const rows =
            (this.tui as unknown as { terminal?: { rows?: number } }).terminal
                ?.rows ?? 24
        const maxTotal = Math.max(12, Math.min(30, rows))
        const contentWidth = Math.max(1, renderWidth - 1)
        const lines: string[] = []
        const add = (text: string) =>
            lines.push(truncateToWidth(text, renderWidth))

        const total = this.state.questions.length
        const title = ` Question ${this.state.questionIndex + 1}/${total} `
        add(
            this.theme.fg(
                'accent',
                `-${title}${'-'.repeat(Math.max(0, renderWidth - visibleWidth(title) - 1))}`
            )
        )

        const progress = this.state.questions
            .map((_item, index) => {
                const marker = this.state.answers.has(index) ? 'x' : ' '
                const label = `[${marker}] ${index + 1}`
                return index === this.state.questionIndex
                    ? this.theme.fg('accent', this.theme.bold(label))
                    : this.theme.fg(
                          this.state.answers.has(index) ? 'success' : 'muted',
                          label
                      )
            })
            .join('  ')
        add(` ${progress}`)
        lines.push('')

        const questionMax = Math.max(2, maxTotal - 10)
        const questionWrapped = wrapTextWithAnsi(
            this.theme.fg(
                'text',
                this.theme.bold(this.state.currentQuestion().question)
            ),
            contentWidth
        )
        const questionOverflow = questionWrapped.length - questionMax
        const questionLines =
            questionOverflow > 0
                ? [
                      ...questionWrapped.slice(0, questionMax - 1),
                      this.theme.fg(
                          'dim',
                          `... ${questionOverflow + 1} more lines`
                      ),
                  ]
                : questionWrapped
        for (const line of questionLines) add(` ${line}`)
        lines.push('')

        const options = this.state.currentOptions()
        const blocks: string[][] = options.map((option, index) => {
            const selected = index === this.state.optionIndex
            const prefix = selected ? this.theme.fg('accent', ' > ') : '   '
            const marker = option.isOther ? '>' : `${index + 1}.`
            const labelStyle = selected
                ? 'accent'
                : option.isOther
                  ? 'muted'
                  : 'text'
            const out: string[] = []
            for (const line of wrapWithPrefix(
                prefix,
                this.theme.fg(labelStyle, `${marker} ${option.label}`),
                renderWidth
            )) {
                out.push(line)
            }
            if (option.description) {
                for (const line of wrapWithPrefix(
                    '      ',
                    this.theme.fg('muted', option.description),
                    renderWidth
                )) {
                    out.push(line)
                }
            }
            return out
        })
        const flat: Array<{ option: number; line: string }> = []
        blocks.forEach((block, option) => {
            for (const line of block) flat.push({ option, line })
        })
        const selectedOption = this.state.optionIndex
        let selectedStart = flat.findIndex(
            (row) => row.option === selectedOption
        )
        if (selectedStart < 0) selectedStart = 0
        let selectedEnd = selectedStart
        for (let i = selectedStart; i < flat.length; i += 1) {
            if (flat[i].option !== selectedOption) break
            selectedEnd = i
        }

        const chromeWithoutOptions =
            lines.length + (this.state.editMode ? 3 : 0) + 3
        let viewport = Math.max(4, maxTotal - chromeWithoutOptions)
        viewport = Math.min(viewport, Math.max(4, flat.length + 2))
        let start = this.scrollOffset
        if (selectedStart < start) start = selectedStart
        if (selectedEnd >= start + viewport) start = selectedEnd - viewport + 1
        start = Math.max(
            0,
            Math.min(start, Math.max(0, flat.length - viewport))
        )

        const layout = (offset: number) => {
            const topHidden = offset
            const bottomHidden = flat.length - (offset + viewport)
            const visible = flat.slice(offset, offset + viewport)
            const reserved =
                (topHidden > 0 ? 1 : 0) + (bottomHidden > 0 ? 1 : 0)
            const bodySize = Math.max(1, viewport - reserved)
            const selPos = selectedStart - offset
            let bodyOffset = 0
            if (selPos >= 0 && selPos < visible.length) {
                bodyOffset = Math.max(
                    0,
                    Math.min(selPos, visible.length - bodySize)
                )
                // Prefer showing the label at the top when it would otherwise clip.
                if (selPos < bodySize) bodyOffset = 0
            }
            const body = visible.slice(bodyOffset, bodyOffset + bodySize)
            return { topHidden, bottomHidden, visible, body, bodySize }
        }
        let laid = layout(start)
        // Keep the selected option label visible when indicators take rows.
        const inBody = laid.body.some((row) => {
            const idx = flat.indexOf(row)
            return idx === selectedStart
        })
        if (!inBody) {
            start = Math.max(
                0,
                Math.min(selectedStart, Math.max(0, flat.length - viewport))
            )
            laid = layout(start)
        }
        this.scrollOffset = start

        const optionLines: string[] = []
        if (laid.topHidden > 0) {
            optionLines.push(
                this.theme.fg('dim', `   ... ${laid.topHidden} more`)
            )
        }
        for (const row of laid.body) optionLines.push(row.line)
        if (laid.bottomHidden > 0) {
            optionLines.push(
                this.theme.fg('dim', `   ... ${laid.bottomHidden} more`)
            )
        }
        for (const line of optionLines) add(line)

        if (this.state.editMode) {
            lines.push('')
            add(this.theme.fg('muted', ' Your answer:'))
            for (const line of this.editor.render(
                Math.max(1, renderWidth - 2)
            )) {
                add(` ${line}`)
            }
        }

        lines.push('')
        add(this.theme.fg('dim', this.hintText()))
        add(this.theme.fg('accent', '-'.repeat(Math.max(1, renderWidth))))

        const fitted =
            lines.length > maxTotal
                ? [...lines.slice(0, maxTotal - 1), lines[lines.length - 1]]
                : lines
        const safe = fitted.map((line) => truncateToWidth(line, renderWidth))
        this.cachedWidth = renderWidth
        this.cachedKey = cacheKey
        this.cachedLines = safe
        return safe
    }
}
