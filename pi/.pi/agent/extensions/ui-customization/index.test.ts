import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import uiCustomization from './index.ts'
import modelInfo from '../model-info/index.ts'
import { SUBAGENTS_INFO_CHANNEL } from '../shared/dashboard-state.ts'

test('footer totals include children while context stays parent-only and session transitions reset child billing', () => {
    const bus = new EventEmitter()
    const handlers = new Map<
        string,
        Array<(event: any, ctx: ExtensionContext) => void>
    >()
    let footer: { render(width: number): string[] } | undefined
    let renders = 0
    let childCost = 0
    const pi = {
        events: {
            on: (name: string, handler: (...args: any[]) => void) => {
                bus.on(name, handler)
                return () => bus.off(name, handler)
            },
            emit: (name: string, value: unknown) => bus.emit(name, value),
        },
        on: (
            name: string,
            handler: (event: any, ctx: ExtensionContext) => void
        ) => {
            handlers.set(name, [...(handlers.get(name) ?? []), handler])
        },
        getThinkingLevel: () => 'off',
    } as unknown as ExtensionAPI
    const ctx = {
        mode: 'tui',
        cwd: '/repo',
        model: {
            provider: 'test',
            id: 'parent',
            contextWindow: 1000,
            reasoning: false,
        },
        modelRegistry: { find: () => undefined },
        sessionManager: {
            getEntries: () => [
                {
                    type: 'message',
                    message: {
                        role: 'assistant',
                        provider: 'test',
                        model: 'parent',
                        usage: {
                            input: 100,
                            output: 5,
                            cacheRead: 300,
                            cacheWrite: 100,
                            cost: { total: 1 },
                        },
                    },
                },
            ],
        },
        getContextUsage: () => ({
            tokens: 100,
            contextWindow: 1000,
            percent: 10,
        }),
        ui: {
            setTitle: () => undefined,
            setFooter: (factory: any) => {
                footer = factory?.(
                    {
                        requestRender: () => {
                            renders += 1
                        },
                    },
                    { fg: (_token: string, text: string) => text },
                    { getExtensionStatuses: () => new Map() }
                )
            },
        },
    } as unknown as ExtensionContext
    modelInfo(pi)
    uiCustomization(pi)
    const dispatch = (name: string, event = {}) => {
        for (const handler of handlers.get(name) ?? []) handler(event, ctx)
    }
    dispatch('session_start')
    assert.ok(footer)
    assert.match(footer.render(180).join('\n'), /10%\/1k.*\$1\.00.*CH60\.0%/)

    childCost = 2 + 3
    pi.events.emit(SUBAGENTS_INFO_CHANNEL, {
        running: 2,
        cost: childCost,
        promptTokens: { input: 100, cacheRead: 100, cacheWrite: 0 },
    })
    // 400 cached of 700 prompt tokens once children are included.
    assert.match(footer.render(180).join('\n'), /10%\/1k.*\$6\.00.*CH57\.1%/)
    assert.ok(renders > 0)
    pi.events.emit(SUBAGENTS_INFO_CHANNEL, {
        running: 0,
        cost: childCost,
        promptTokens: { input: 100, cacheRead: 100, cacheWrite: 0 },
    })
    assert.match(footer.render(180).join('\n'), /\$6\.00.*CH57\.1%/)

    // The parent's finalized response is not persisted yet at message_end.
    dispatch('message_end', {
        message: {
            role: 'assistant',
            provider: 'test',
            model: 'parent',
            content: [],
            usage: {
                input: 100,
                output: 5,
                cacheRead: 300,
                cacheWrite: 100,
                cost: { total: 0.5 },
            },
        },
    })
    assert.match(footer.render(180).join('\n'), /\$6\.50/)

    dispatch('session_start')
    assert.match(footer.render(180).join('\n'), /\$1\.00.*CH60\.0%/)
    pi.events.emit(SUBAGENTS_INFO_CHANNEL, {
        running: 1,
        cost: NaN,
        promptTokens: { input: NaN, cacheRead: NaN, cacheWrite: NaN },
    })
    assert.match(footer.render(180).join('\n'), /\$1\.00.*CH60\.0%/)
    dispatch('session_shutdown')
    assert.equal(footer, undefined)
})
