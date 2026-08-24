import assert from 'node:assert/strict'
import test from 'node:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ZenHealthTracker } from './health.ts'
import { registerZenFreeExtension, runZenProbe } from './index.ts'
import { createZenFreeProvider } from './provider.ts'

function model(
    id: string,
    api: 'openai-completions' | 'openai-responses' = 'openai-completions',
    provider = 'zen-free'
): Model<Api> {
    return {
        id,
        name: id,
        api,
        provider,
        baseUrl: 'https://opencode.ai/zen/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16000,
    }
}

function assistant(overrides: Record<string, unknown> = {}) {
    return {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'zen-free',
        model: 'model',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: 'error',
        errorMessage: 'Model is unavailable',
        timestamp: Date.now(),
        ...overrides,
    }
}

interface MockPi {
    pi: ExtensionAPI
    handlers: Map<string, Array<(event: any, ctx: any) => any>>
    commands: Map<string, (args: string, ctx: any) => Promise<void>>
    providers: unknown[]
    selected: Model<Api>[]
    sentUserMessages: string[]
}

function createMockPi(): MockPi {
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
    const commands = new Map<
        string,
        (args: string, ctx: any) => Promise<void>
    >()
    const providers: unknown[] = []
    const selected: Model<Api>[] = []
    const sentUserMessages: string[] = []
    const pi = {
        on(name: string, handler: (event: any, ctx: any) => any) {
            const registered = handlers.get(name) ?? []
            registered.push(handler)
            handlers.set(name, registered)
        },
        registerProvider(provider: unknown) {
            providers.push(provider)
        },
        registerCommand(
            name: string,
            options: { handler: (args: string, ctx: any) => Promise<void> }
        ) {
            commands.set(name, options.handler)
        },
        async setModel(next: Model<Api>) {
            selected.push(next)
            return true
        },
        sendUserMessage(text: string) {
            sentUserMessages.push(text)
        },
    } as unknown as ExtensionAPI
    return { pi, handlers, commands, providers, selected, sentUserMessages }
}

function createContext(
    options: {
        active?: Model<Api>
        available?: Model<Api>[]
        confirm?: boolean
        fetchAuth?: {
            ok: true
            apiKey?: string
            headers?: Record<string, string>
        }
    } = {}
) {
    const notifications: Array<{ message: string; type?: string }> = []
    const statuses = new Map<string, string | undefined>()
    let confirms = 0
    const available = options.available ?? []
    return {
        ctx: {
            model: options.active,
            mode: 'print',
            ui: {
                notify(message: string, type?: string) {
                    notifications.push({ message, type })
                },
                setStatus(key: string, value: string | undefined) {
                    statuses.set(key, value)
                },
                async confirm() {
                    confirms++
                    return options.confirm ?? true
                },
            },
            sessionManager: { getSessionId: () => 'real-session-id' },
            modelRegistry: {
                getAvailable: () => available,
                find: (provider: string, id: string) =>
                    available.find(
                        (entry) =>
                            entry.provider === provider && entry.id === id
                    ),
                getApiKeyAndHeaders: async () =>
                    options.fetchAuth ?? { ok: true, apiKey: 'public' },
                refresh: async () => ({ errors: new Map() }),
            },
            waitForIdle: async () => {},
        },
        notifications,
        statuses,
        get confirms() {
            return confirms
        },
    }
}

test('Zen header hook is scoped, unique per request, and preserves Pi session attribution', () => {
    const mock = createMockPi()
    registerZenFreeExtension(mock.pi, { runtime: createZenFreeProvider() })
    assert.equal(mock.providers.length, 1)
    const handler = mock.handlers.get('before_provider_headers')![0]!

    const unrelated = { 'x-opencode-session': 'session', keep: 'yes' }
    handler(
        { headers: unrelated },
        createContext({ active: model('other', 'openai-completions', 'other') })
            .ctx
    )
    assert.deepEqual(unrelated, {
        'x-opencode-session': 'session',
        keep: 'yes',
    })

    const first = { 'x-opencode-session': 'real-session' }
    const second = { 'x-opencode-session': 'real-session' }
    const zen = createContext({ active: model('zen') }).ctx
    const zenWithoutAttribution = { keep: 'yes' }
    handler({ headers: zenWithoutAttribution }, zen)
    assert.deepEqual(zenWithoutAttribution, { keep: 'yes' })
    handler({ headers: first }, zen)
    handler({ headers: second }, zen)
    assert.match(first['x-opencode-request' as keyof typeof first], /^req_/)
    assert.notEqual(
        first['x-opencode-request' as keyof typeof first],
        second['x-opencode-request' as keyof typeof second]
    )
    assert.equal(first['x-opencode-session'], 'real-session')
})

test('quota text in a user message cannot change health', () => {
    const mock = createMockPi()
    const health = new ZenHealthTracker(() => 1_000)
    registerZenFreeExtension(mock.pi, {
        runtime: createZenFreeProvider(),
        health,
    })
    const handler = mock.handlers.get('message_end')![0]!
    handler(
        {
            message: {
                role: 'user',
                content: 'FreeUsageLimitError',
                timestamp: 1,
            },
        },
        createContext({ active: model('model') }).ctx
    )
    assert.equal(health.getProviderQuota().active, false)
})

test('assistant errors use message identity and exact quota errors become provider-wide', () => {
    const mock = createMockPi()
    const health = new ZenHealthTracker(() => 1_000)
    registerZenFreeExtension(mock.pi, {
        runtime: createZenFreeProvider(),
        health,
    })
    const handler = mock.handlers.get('message_end')![0]!
    handler(
        {
            message: assistant({
                errorMessage: 'FreeUsageLimitError: free usage limit reached',
            }),
        },
        createContext({ active: model('other', 'openai-completions', 'other') })
            .ctx
    )
    assert.equal(health.getProviderQuota().active, true)
})

test('fallback command changes models without sending a user message', async () => {
    const mock = createMockPi()
    registerZenFreeExtension(mock.pi, { runtime: createZenFreeProvider() })
    const context = createContext({
        active: model('current'),
        available: [model('big-pickle'), model('nemotron-3-ultra-free')],
    })
    await mock.commands.get('zen-free-fallback')!('', context.ctx)
    assert.equal(mock.selected[0]?.id, 'nemotron-3-ultra-free')
    assert.deepEqual(mock.sentUserMessages, [])
})

test('fallback command refuses provider-wide quota cooldown', async () => {
    const mock = createMockPi()
    const health = new ZenHealthTracker(() => 1_000)
    health.recordFailure('current', 'quota_exhausted')
    registerZenFreeExtension(mock.pi, {
        runtime: createZenFreeProvider(),
        health,
    })
    const context = createContext({
        active: model('current'),
        available: [model('big-pickle')],
    })

    await mock.commands.get('zen-free-fallback')!('', context.ctx)

    assert.equal(mock.selected.length, 0)
    assert.match(
        context.notifications[0]?.message ?? '',
        /quota is cooling down/
    )
})

test('status command reports stale catalog and cooldowns', async () => {
    const mock = createMockPi()
    const health = new ZenHealthTracker(() => 1_000)
    health.recordFailure('big-pickle', 'model_unavailable')
    const base = createZenFreeProvider()
    registerZenFreeExtension(mock.pi, {
        health,
        runtime: {
            provider: base.provider,
            getCatalogStatus: () => ({
                source: 'stored',
                checkedAt: 0,
                stale: true,
                modelCount: 1,
                ignored: [{ id: 'deprecated', reason: 'deprecated' }],
            }),
        },
    })
    const context = createContext({ active: model('big-pickle') })
    await mock.commands.get('zen-free-status')!('', context.ctx)
    const output = context.notifications[0]?.message ?? ''
    assert.match(output, /Stale: yes/)
    assert.match(output, /big-pickle: cooldown until/)
    assert.match(output, /deprecated: deprecated/)
})

test('probe requires confirmation and sends Chat Completions payload', async () => {
    const mock = createMockPi()
    let requestBody: any
    const fetchFn: typeof fetch = async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        return Response.json({
            choices: [
                {
                    message: {
                        tool_calls: [
                            { function: { name: 'ping', arguments: '{}' } },
                        ],
                    },
                },
            ],
        })
    }
    registerZenFreeExtension(mock.pi, {
        runtime: createZenFreeProvider(),
        fetch: fetchFn,
    })
    const target = model('probe-model')
    const context = createContext({ available: [target], confirm: true })
    await mock.commands.get('zen-free-probe')!('probe-model', context.ctx)
    assert.equal(context.confirms, 1)
    assert.equal(requestBody.max_tokens, 32)
    assert.equal(requestBody.tools[0].function.name, 'ping')
    assert.deepEqual(mock.sentUserMessages, [])
})

test('probe HTTP errors do not expose resolved API keys', async () => {
    const secret = 'secret-provider-key'
    const result = await runZenProbe({
        model: model('probe-model'),
        auth: { apiKey: secret },
        sessionId: 'session-id',
        signal: new AbortController().signal,
        fetch: async () =>
            new Response(`invalid authorization: Bearer ${secret}`, {
                status: 400,
            }),
    })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'Probe request failed with HTTP 400')
    assert.doesNotMatch(result.error ?? '', new RegExp(secret))
})

test('Responses probe uses the Responses API payload', async () => {
    let body: any
    const result = await runZenProbe({
        model: model('responses-model', 'openai-responses'),
        auth: { apiKey: 'public' },
        sessionId: 'session-id',
        signal: new AbortController().signal,
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body))
            return Response.json({
                output: [{ type: 'function_call', name: 'ping' }],
            })
        },
    })
    assert.equal(result.ok, true)
    assert.equal(body.max_output_tokens, 32)
    assert.equal(body.tools[0].name, 'ping')
    assert.equal(body.messages, undefined)
})

test('session shutdown clears health and extension statuses', () => {
    const mock = createMockPi()
    const health = new ZenHealthTracker(() => 1_000)
    health.recordFailure('model', 'model_unavailable')
    registerZenFreeExtension(mock.pi, {
        runtime: createZenFreeProvider(),
        health,
    })
    const context = createContext()
    mock.handlers.get('session_shutdown')![0]!({}, context.ctx)
    assert.equal(health.getModelHealth('model').state, 'unknown')
    assert.equal(context.statuses.get('zen-free-health'), undefined)
    assert.equal(context.statuses.get('zen-free'), undefined)
})
