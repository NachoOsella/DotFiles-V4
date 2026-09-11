import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import askUser from './index.ts'

function createTool() {
    const tools: Array<Record<string, unknown>> = []
    const pi = {
        registerTool(tool: Record<string, unknown>) {
            tools.push(tool)
        },
    } as unknown as ExtensionAPI
    askUser(pi)
    assert.equal(tools.length, 1)
    return tools[0] as unknown as {
        name: string
        executionMode?: string
        parameters: unknown
        prepareArguments: (args: unknown) => unknown
        execute: (
            id: string,
            params: never,
            signal: AbortSignal | undefined,
            onUpdate: undefined,
            ctx: ExtensionContext
        ) => Promise<{ content: Array<{ text: string }>; details: unknown }>
    }
}

function validParams() {
    return {
        questions: [
            {
                question: 'First?',
                options: [{ label: 'A1' }, { label: 'A2' }],
            },
            {
                question: 'Second?',
                options: [{ label: 'B1' }, { label: 'B2' }],
            },
        ],
    } as never
}

function createCtx(
    mode: ExtensionContext['mode'],
    custom?: ExtensionContext['ui']['custom']
) {
    let calls = 0
    const ui = {
        custom: (async (...args: unknown[]) => {
            calls += 1
            if (custom) {
                return (custom as (...a: never[]) => unknown)(
                    ...(args as never[])
                )
            }
            return null
        }) as ExtensionContext['ui']['custom'],
    }
    const ctx = { mode, ui } as unknown as ExtensionContext
    return { ctx, getCalls: () => calls }
}

test('registers a single sequential questionnaire tool', () => {
    const tool = createTool()
    assert.equal(tool.name, 'ask_user')
    assert.equal(tool.executionMode, 'sequential')
})

test('preserves single-question prepareArguments compatibility', () => {
    const tool = createTool()
    const prepared = tool.prepareArguments({
        question: 'Solo?',
        options: [{ label: 'Yes' }, { label: 'No' }],
    }) as { questions: Array<{ question: string }> }
    assert.equal(prepared.questions.length, 1)
    assert.equal(prepared.questions[0].question, 'Solo?')
})

test('modes without UI return unavailable', async () => {
    const tool = createTool()
    for (const mode of ['json', 'print'] as const) {
        const { ctx, getCalls } = createCtx(mode)
        const result = await tool.execute(
            'id',
            validParams(),
            undefined,
            undefined,
            ctx
        )
        assert.equal(getCalls(), 0)
        const details = result.details as {
            cancelled: boolean
            outcome: string
            answers: unknown[]
        }
        assert.equal(details.outcome, 'unavailable')
        assert.equal(details.cancelled, true)
        assert.deepEqual(details.answers, [])
        assert.match(result.content[0].text, /plain text/)
        assert.doesNotMatch(result.content[0].text, /dismissed/i)
    }
})

test('RPC mode asks sequentially and returns ordered answers', async () => {
    const tool = createTool()
    const selections = ['A2', 'Write my own answer...']
    const titles: string[] = []
    const ui = {
        select: async (title: string) => {
            titles.push(title)
            return selections.shift()
        },
        input: async () => 'mine',
    }
    const ctx = { mode: 'rpc', hasUI: true, ui } as unknown as ExtensionContext
    const result = await tool.execute(
        'id',
        validParams(),
        undefined,
        undefined,
        ctx
    )
    const details = result.details as {
        outcome: string
        cancelled: boolean
        answers: Array<Record<string, unknown>>
    }
    assert.deepEqual(titles, ['Question 1/2: First?', 'Question 2/2: Second?'])
    assert.equal(details.outcome, 'answered')
    assert.equal(details.cancelled, false)
    assert.deepEqual(details.answers, [
        { question: 'First?', answer: 'A2', wasCustom: false, index: 2 },
        { question: 'Second?', answer: 'mine', wasCustom: true },
    ])
    assert.match(result.content[0].text, /selected option 2: A2/)
    assert.match(result.content[0].text, /wrote their own answer: mine/)
})

test('RPC cancellation dismisses the whole questionnaire', async () => {
    const tool = createTool()
    const ui = { select: async () => undefined }
    const ctx = { mode: 'rpc', hasUI: true, ui } as unknown as ExtensionContext
    const result = await tool.execute(
        'id',
        validParams(),
        undefined,
        undefined,
        ctx
    )
    const details = result.details as { outcome: string; cancelled: boolean }
    assert.equal(details.outcome, 'dismissed')
    assert.equal(details.cancelled, true)
})

test('pre-aborted signal returns aborted without custom UI', async () => {
    const tool = createTool()
    const { ctx, getCalls } = createCtx('tui')
    const controller = new AbortController()
    controller.abort()
    const result = await tool.execute(
        'id',
        validParams(),
        controller.signal,
        undefined,
        ctx
    )
    assert.equal(getCalls(), 0)
    const details = result.details as { outcome: string; cancelled: boolean }
    assert.equal(details.outcome, 'aborted')
    assert.equal(details.cancelled, true)
})

test('dismissed custom UI preserves legacy cancelled flag', async () => {
    const tool = createTool()
    const { ctx } = createCtx('tui', (async () => null) as never)
    const result = await tool.execute(
        'id',
        validParams(),
        undefined,
        undefined,
        ctx
    )
    const details = result.details as { outcome: string; cancelled: boolean }
    assert.equal(details.outcome, 'dismissed')
    assert.equal(details.cancelled, true)
    assert.match(result.content[0].text, /dismissed/i)
})

test('answered custom UI returns ordered answers', async () => {
    const tool = createTool()
    const answers = [
        { question: 'First?', answer: 'A1', wasCustom: false, index: 1 },
        { question: 'Second?', answer: 'mine', wasCustom: true },
    ]
    const { ctx } = createCtx('tui', (async () => answers) as never)
    const result = await tool.execute(
        'id',
        validParams(),
        undefined,
        undefined,
        ctx
    )
    const details = result.details as {
        outcome: string
        cancelled: boolean
        answers: typeof answers
    }
    assert.equal(details.outcome, 'answered')
    assert.equal(details.cancelled, false)
    assert.deepEqual(details.answers, answers)
})

test('abort during UI settles to aborted', async () => {
    const tool = createTool()
    const { ctx } = createCtx('tui', (() => new Promise(() => {})) as never)
    const controller = new AbortController()
    const pending = tool.execute(
        'id',
        validParams(),
        controller.signal,
        undefined,
        ctx
    )
    controller.abort()
    const result = await pending
    const details = result.details as { outcome: string; cancelled: boolean }
    assert.equal(details.outcome, 'aborted')
    assert.equal(details.cancelled, true)
})

test('double abort during UI settles once', async () => {
    const tool = createTool()
    let captured: {
        tui: unknown
        theme: unknown
        keybindings: unknown
        done: (value: unknown) => void
    } | null = null
    const { ctx } = createCtx('tui', ((
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (v: unknown) => void
    ) => {
        captured = { tui, theme, keybindings, done }
        return new Promise(() => {})
    }) as never)
    const controller = new AbortController()
    const pending = tool.execute(
        'id',
        validParams(),
        controller.signal,
        undefined,
        ctx
    )
    // Wait for the factory to be captured, then abort twice.
    for (let i = 0; i < 100 && !captured; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(captured)
    controller.abort()
    controller.abort()
    const result = await pending
    const details = result.details as { outcome: string }
    assert.equal(details.outcome, 'aborted')
})
