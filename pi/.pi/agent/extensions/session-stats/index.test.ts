import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import sessionStatsExtension from './index.ts'
import { SUBAGENTS_INFO_CHANNEL } from '../shared/dashboard-state.ts'

test('/stats reads live child usage and rejects snapshots from a different root after switching sessions', async () => {
    const bus = new EventEmitter()
    const handlers = new Map<string, () => void>()
    let command:
        | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
        | undefined
    let output = ''
    let rootSessionId = 'root-a'
    sessionStatsExtension({
        events: {
            on: (name: string, handler: (...args: any[]) => void) => {
                bus.on(name, handler)
                return () => bus.off(name, handler)
            },
        },
        on: (name: string, handler: () => void) => {
            handlers.set(name, handler)
        },
        registerCommand: (
            _name: string,
            definition: { handler: typeof command }
        ) => {
            command = definition.handler
        },
    } as unknown as ExtensionAPI)
    const ctx = {
        mode: 'rpc',
        hasUI: true,
        modelRegistry: { find: () => undefined },
        sessionManager: {
            getSessionId: () => rootSessionId,
            getSessionFile: () => undefined,
            getSessionName: () => undefined,
            getEntries: () => [
                {
                    type: 'message',
                    message: {
                        role: 'assistant',
                        provider: 'test',
                        model: 'parent',
                        usage: {
                            input: 10,
                            output: 10,
                            cacheRead: 0,
                            cacheWrite: 0,
                            cost: { total: 2 },
                        },
                    },
                },
            ],
        },
        ui: {
            notify: (text: string) => {
                output = text
            },
        },
    } as unknown as ExtensionCommandContext
    const snapshot = {
        version: 2,
        rootSessionId: 'root-a',
        persistedAt: Date.now(),
        agents: [
            {
                id: 'worker',
                path: '/root/worker',
                parentPath: '/root',
                rootSessionId: 'root-a',
                model: { provider: 'test', id: 'worker' },
                status: 'Running',
                activeTools: [],
                createdAt: 1,
                lastActivityAt: 2,
                runSequence: 1,
                usage: {
                    provider: 'test',
                    modelId: 'worker',
                    input: 100,
                    output: 50,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 3,
                    userMessages: 1,
                    assistantMessages: 1,
                    toolResults: 0,
                    toolCalls: [],
                },
            },
        ],
    }
    handlers.get('session_start')!()
    bus.emit(SUBAGENTS_INFO_CHANNEL, { running: 1, cost: 3, snapshot })
    await command!('', ctx)
    assert.match(output, /1 subagent/)
    assert.match(output, /\$5\.00/)
    assert.match(output, /worker/)
    rootSessionId = 'root-b'
    await command!('', ctx)
    assert.doesNotMatch(output, /1 subagent/)
    assert.match(output, /\$2\.00/)
    handlers.get('session_shutdown')!()
    assert.equal(bus.listenerCount(SUBAGENTS_INFO_CHANNEL), 0)
})
