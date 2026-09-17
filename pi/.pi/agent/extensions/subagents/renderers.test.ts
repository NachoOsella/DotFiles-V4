import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from './src/config.ts'
import { buildRootToolDefinitions } from './src/extension-tools.ts'

const stubTheme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme

const stubManager = {
    getConfig: () => DEFAULT_SUBAGENTS_CONFIG,
} as never

interface Renderable {
    render: (width: number) => string[]
}

function linesOf(component: unknown): string[] {
    return (component as Renderable).render(100)
}

function textOf(component: unknown): string {
    return linesOf(component).join('\n')
}

function tool(name: string) {
    const found = buildRootToolDefinitions(stubManager).find(
        (entry) => (entry as { name: string }).name === name
    )
    assert.ok(found, `tool not registered: ${name}`)
    return found as {
        renderCall: (args: never, theme: never) => unknown
        renderResult: (
            result: never,
            options: never,
            theme: never,
            context: never
        ) => unknown
    }
}

const callContext = (args: unknown) => ({ args }) as never

describe('tool call rendering', () => {
    it('spawn shows task, type and message preview instead of raw JSON', () => {
        const text = textOf(
            tool('spawn_agent').renderCall(
                {
                    task_name: 'historia_uno',
                    message: 'Cuéntame una historia breve y original',
                    agent_type: 'default',
                    fork_turns: 'none',
                } as never,
                stubTheme as never
            )
        )
        assert.match(text, /spawn_agent/)
        assert.match(text, /historia_uno/)
        assert.match(text, /fork:none/)
        assert.match(text, /Cuéntame una historia/)
        assert.ok(!text.includes('"task_name"'))
    })

    it('wait call shows a human timeout', () => {
        const text = textOf(
            tool('wait_agent').renderCall(
                { timeout_ms: 20000 } as never,
                stubTheme as never
            )
        )
        assert.match(text, /wait_agent/)
        assert.match(text, /20s/)
    })

    it('message calls show target and preview', () => {
        const text = textOf(
            tool('followup_task').renderCall(
                { target: '/root/worker', message: 'sigue con eso' } as never,
                stubTheme as never
            )
        )
        assert.match(text, /\/root\/worker/)
        assert.match(text, /sigue con eso/)
    })
})

describe('tool result rendering', () => {
    it('spawn result shows the canonical path with metadata on expand', () => {
        const render = tool('spawn_agent').renderResult
        const result = {
            content: [{ type: 'text', text: '{"task_name":"/root/a"}' }],
            details: {
                task_name: '/root/a',
                agent_type: 'reviewer',
                model: 'opencode/muse-spark',
                thinking_level: 'high',
            },
        } as never
        const compact = textOf(
            render(result, {} as never, stubTheme as never, callContext({}))
        )
        assert.match(compact, /\/root\/a/)
        assert.ok(!compact.includes('reviewer'))
        const expanded = textOf(
            render(
                result,
                { expanded: true } as never,
                stubTheme as never,
                callContext({})
            )
        )
        assert.match(expanded, /reviewer/)
        assert.match(expanded, /muse-spark/)
        assert.match(expanded, /thinking:high/)
    })

    it('wait result distinguishes completion, interruption and timeout', () => {
        const render = tool('wait_agent').renderResult
        const completed = textOf(
            render(
                {
                    content: [],
                    details: { message: 'Wait completed.', timed_out: false },
                } as never,
                {} as never,
                stubTheme as never,
                callContext({ timeout_ms: 10000 })
            )
        )
        assert.match(completed, /activity/)
        const interrupted = textOf(
            render(
                {
                    content: [],
                    details: {
                        message: 'Wait interrupted by new input.',
                        timed_out: false,
                    },
                } as never,
                {} as never,
                stubTheme as never,
                callContext({})
            )
        )
        assert.match(interrupted, /interrupted/)
        const timedOut = textOf(
            render(
                {
                    content: [],
                    details: { message: 'Wait timed out.', timed_out: true },
                } as never,
                {} as never,
                stubTheme as never,
                callContext({ timeout_ms: 10000 })
            )
        )
        assert.match(timedOut, /timed out/)
        assert.match(timedOut, /10s/)
    })

    it('list result renders one row per agent with status', () => {
        const render = tool('list_agents').renderResult
        const text = textOf(
            render(
                {
                    content: [],
                    details: {
                        agents: [
                            {
                                agent_name: '/root/worker',
                                agent_status: 'Running',
                                residency: 'loaded',
                                role: 'default',
                                model: 'opencode/muse-spark',
                                thinking_level: 'xhigh',
                                has_pending_mail: true,
                                running: true,
                            },
                            {
                                agent_name: '/root/other',
                                agent_status: 'Completed',
                                residency: 'loaded',
                                role: 'default',
                                model: 'opencode/muse-spark',
                                has_pending_mail: false,
                                running: false,
                            },
                        ],
                    },
                } as never,
                {} as never,
                stubTheme as never,
                callContext({})
            )
        )
        assert.match(text, /2 agents/)
        assert.match(text, /worker/)
        assert.match(text, /Running/)
        assert.match(text, /Completed/)
        assert.match(text, /thinking:xhigh/)
    })

    it('message results confirm the delivery target', () => {
        const text = textOf(
            tool('send_message').renderResult(
                { content: [], details: { delivered: true } } as never,
                {} as never,
                stubTheme as never,
                callContext({ target: '/root/worker' })
            )
        )
        assert.match(text, /delivered/)
        assert.match(text, /\/root\/worker/)
    })
})
