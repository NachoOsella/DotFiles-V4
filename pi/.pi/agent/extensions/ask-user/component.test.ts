import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { TUI } from '@earendil-works/pi-tui'
import { QuestionnaireComponent } from './component.ts'

function createTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    }
}

function createKeybindings() {
    const map: Record<string, string[]> = {
        'tui.select.up': ['up'],
        'tui.select.down': ['down'],
        'tui.select.pageUp': ['pageUp'],
        'tui.select.pageDown': ['pageDown'],
        'tui.select.confirm': ['enter'],
        'tui.select.cancel': ['esc'],
        'tui.editor.cursorLeft': ['left'],
        'tui.editor.cursorRight': ['right'],
        'tui.input.submit': ['enter'],
    }
    return {
        matches(data: string, binding: string): boolean {
            return (map[binding] ?? []).includes(data)
        },
        getKeys(binding: string): string[] {
            return [...(map[binding] ?? [])]
        },
    }
}

function createTui(rows = 24) {
    return {
        terminal: { rows, cols: 80 },
        requestRender() {},
        setFocus() {},
    } as unknown as TUI
}

function sampleQuestions() {
    return [
        {
            question: 'Pick a color for the deployment pipeline?',
            options: [
                { label: 'Red', description: 'Stop and fix' },
                { label: 'Green', description: 'Go ahead' },
            ],
        },
        {
            question: 'Pick a region?',
            options: [{ label: 'East' }, { label: 'West' }],
        },
    ]
}

function createComponent(rows = 24) {
    const tui = createTui(rows)
    const theme = createTheme()
    const keybindings = createKeybindings()
    let result: unknown
    let calls = 0
    const component = new QuestionnaireComponent(
        tui,
        theme,
        keybindings,
        sampleQuestions(),
        (value) => {
            calls += 1
            result = value
        }
    )
    component.focused = true
    return {
        component,
        getResult: () => result,
        getCalls: () => calls,
    }
}

function plain(lines: string[]): string[] {
    return lines.map((line) => stripTerminalSequences(line))
}

test('render(80) then render(10) fits 10 columns', () => {
    const { component } = createComponent()
    try {
        const wide = component.render(80)
        assert.ok(wide.length > 0)
        for (const line of plain(wide)) {
            assert.ok(visibleWidth(line) <= 80, `wide line overflow: ${line}`)
        }
        const narrow = component.render(10)
        assert.ok(narrow.length > 0)
        for (const line of plain(narrow)) {
            assert.ok(visibleWidth(line) <= 10, `narrow line overflow: ${line}`)
        }
        assert.notDeepEqual(plain(wide), plain(narrow))
    } finally {
        component.dispose()
    }
})

test('render cache is keyed by width and state', () => {
    const { component } = createComponent()
    try {
        const first = component.render(40)
        const same = component.render(40)
        assert.equal(same, first)
        component.handleInput('down')
        const moved = component.render(40)
        assert.notEqual(moved, first)
        const otherWidth = component.render(20)
        assert.notEqual(otherWidth, moved)
        for (const line of plain(otherWidth)) {
            assert.ok(visibleWidth(line) <= 20)
        }
    } finally {
        component.dispose()
    }
})

test('width zero returns no lines without throwing', () => {
    const { component } = createComponent()
    try {
        assert.deepEqual(component.render(0), [])
        assert.deepEqual(component.render(-5), [])
    } finally {
        component.dispose()
    }
})

test('unbroken long words wrap by terminal cells', () => {
    const tui = createTui()
    const component = new QuestionnaireComponent(
        tui,
        createTheme(),
        createKeybindings(),
        [
            {
                question: 'Q?',
                options: [{ label: 'x'.repeat(50) }, { label: 'y' }],
            },
        ],
        () => {}
    )
    try {
        component.focused = true
        const lines = plain(component.render(10))
        assert.ok(lines.length > 1)
        for (const line of lines) {
            assert.ok(visibleWidth(line) <= 10, `overflow: ${line}`)
        }
        const joined = lines.join('').replace(/[^xy]/g, '')
        assert.ok(joined.includes('x'.repeat(10)))
    } finally {
        component.dispose()
    }
})

test('CJK text wraps by terminal cells', () => {
    const tui = createTui()
    const component = new QuestionnaireComponent(
        tui,
        createTheme(),
        createKeybindings(),
        [
            {
                question: '日本語テスト日本語テスト日本語テスト?',
                options: [{ label: 'はい' }, { label: 'いいえ' }],
            },
        ],
        () => {}
    )
    try {
        component.focused = true
        const lines = plain(component.render(10))
        assert.ok(lines.length > 1)
        for (const line of lines) {
            assert.ok(visibleWidth(line) <= 10, `overflow: ${line}`)
        }
    } finally {
        component.dispose()
    }
})

test('focus forwards to the editor only while editing', () => {
    const { component } = createComponent()
    try {
        const editor = (
            component as unknown as { editor: { focused: boolean } }
        ).editor
        assert.equal(editor.focused, false)
        const other = component.state.currentOptions().length - 1
        component.handleInput(String(other + 1))
        assert.equal(component.state.editMode, true)
        assert.equal(editor.focused, true)
        component.handleInput('esc')
        assert.equal(component.state.editMode, false)
        assert.equal(editor.focused, false)
    } finally {
        component.dispose()
    }
})

test('invalidate clears the cache and the editor', () => {
    const { component } = createComponent()
    try {
        const editor = (
            component as unknown as { editor: { invalidate(): void } }
        ).editor
        let editorInvalidated = 0
        const original = editor.invalidate.bind(editor)
        editor.invalidate = () => {
            editorInvalidated += 1
            original()
        }
        const first = component.render(40)
        assert.equal(component.render(40), first)
        component.invalidate()
        assert.equal(editorInvalidated, 1)
        const after = component.render(40)
        assert.notEqual(after, first)
    } finally {
        component.dispose()
    }
})

test('selection uses the injected keybinding manager', () => {
    const tui = createTui()
    const customBindings = {
        matches(data: string, binding: string): boolean {
            if (binding === 'tui.select.down') return data === 'j'
            if (binding === 'tui.select.confirm') return data === 'o'
            if (binding === 'tui.select.cancel') return data === 'q'
            return false
        },
        getKeys(binding: string): string[] {
            if (binding === 'tui.select.down') return ['j']
            if (binding === 'tui.select.confirm') return ['o']
            if (binding === 'tui.select.cancel') return ['q']
            return []
        },
    }
    let result: unknown
    let calls = 0
    const component = new QuestionnaireComponent(
        tui,
        createTheme(),
        customBindings,
        sampleQuestions(),
        (value) => {
            calls += 1
            result = value
        }
    )
    try {
        component.focused = true
        assert.equal(component.state.optionIndex, 0)
        component.handleInput('j')
        assert.equal(component.state.optionIndex, 1)
        // Hardcoded "down" must not move when the manager uses "j".
        component.handleInput('down')
        assert.equal(component.state.optionIndex, 1)
        component.handleInput('1')
        assert.equal(component.state.questionIndex, 1)
        component.handleInput('o')
        assert.equal(calls, 1)
        assert.ok(Array.isArray(result))
    } finally {
        component.dispose()
    }
})

test('numbered shortcuts keep working alongside the manager', () => {
    const { component, getResult, getCalls } = createComponent()
    try {
        component.handleInput('2')
        assert.equal(component.state.questionIndex, 1)
        component.handleInput('1')
        assert.equal(getCalls(), 1)
        const answers = getResult() as Array<{ answer: string }>
        assert.deepEqual(
            answers.map((a) => a.answer),
            ['Green', 'East']
        )
    } finally {
        component.dispose()
    }
})

test('dismissal settles once', () => {
    const { component, getResult, getCalls } = createComponent()
    try {
        component.handleInput('esc')
        component.handleInput('esc')
        assert.equal(getCalls(), 1)
        assert.equal(getResult(), null)
    } finally {
        component.dispose()
    }
})

test('abort settles once', () => {
    const { component, getResult, getCalls } = createComponent()
    try {
        component.abort()
        component.abort()
        component.dismiss()
        assert.equal(getCalls(), 1)
        assert.equal(getResult(), null)
    } finally {
        component.dispose()
    }
})

test('long options scroll within terminal height', () => {
    const tui = createTui(10)
    const options = Array.from({ length: 6 }, (_, i) => ({
        label: `Option ${i + 1} with a long label that wraps across lines`,
        description: `Description ${i + 1} with enough detail to wrap across multiple terminal lines for scrolling`,
    }))
    const component = new QuestionnaireComponent(
        tui,
        createTheme(),
        createKeybindings(),
        [{ question: 'Choose?', options }],
        () => {}
    )
    try {
        component.focused = true
        const lines = plain(component.render(40))
        assert.ok(
            lines.length <= 12,
            `expected bounded height, got ${lines.length}`
        )
        assert.ok(lines.some((line) => line.includes('more')))
        component.state.setOptionIndex(5)
        const scrolled = plain(component.render(40))
        assert.ok(scrolled.some((line) => line.includes('Option 6')))
        component.state.setOptionIndex(6)
        const custom = plain(component.render(40))
        assert.ok(custom.some((line) => line.includes('Write my own')))
    } finally {
        component.dispose()
    }
})

test('hint shows only available question navigation', () => {
    const { component } = createComponent()
    try {
        const first = plain(component.render(80)).join('\n')
        assert.ok(first.includes('next'))
        assert.ok(!first.includes('prev'))
        component.handleInput('right')
        const second = plain(component.render(80)).join('\n')
        assert.ok(second.includes('prev'))
        assert.ok(!second.includes('next'))
    } finally {
        component.dispose()
    }
})
