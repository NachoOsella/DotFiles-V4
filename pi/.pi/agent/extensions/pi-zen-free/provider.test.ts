import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
    createModels,
    InMemoryModelsStore,
    type Model,
    type ModelsStoreEntry,
    type RefreshModelsContext,
} from '@earendil-works/pi-ai'
import {
    MODELS_DEV_URL,
    PI_CATALOG_URL,
    PROVIDER_ID,
    REFRESH_INTERVAL_MS,
    ZEN_MODELS_URL,
} from './config.ts'
import { legacyCachePath, migratedLegacyCachePath } from './cache.ts'
import { BOOTSTRAP_MODELS } from './models.ts'
import {
    createZenFreeProvider,
    type CreateZenProviderOptions,
    zenFreeApiKeyAuth,
} from './provider.ts'

const TEST_AGENT_DIR = join(
    tmpdir(),
    `pi-zen-free-provider-tests-${process.pid}`
)

function createTestProvider(options: CreateZenProviderOptions = {}) {
    return createZenFreeProvider({ ...options, agentDir: TEST_AGENT_DIR })
}

function catalogModel(id = 'eligible'): Model<'openai-completions'> {
    return {
        id,
        name: id,
        api: 'openai-completions',
        provider: 'opencode',
        baseUrl: 'https://opencode.ai/zen/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
        },
    }
}

function devModel(id = 'eligible') {
    return {
        id,
        name: id,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: 32000 },
    }
}

function successfulFetch(
    options: {
        id?: string
        malformedSource?: string
        failingSource?: string
        delay?: Promise<void>
        calls?: string[]
    } = {}
): typeof fetch {
    const id = options.id ?? 'eligible'
    return async (input, init) => {
        await options.delay
        const url = String(input)
        options.calls?.push(url)
        init?.signal?.throwIfAborted()
        if (url === options.failingSource)
            return new Response('failed', { status: 503 })
        if (url === options.malformedSource)
            return new Response('{', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        if (url === PI_CATALOG_URL)
            return Response.json(
                { models: [catalogModel(id)] },
                { headers: { etag: '"pi"' } }
            )
        if (url === ZEN_MODELS_URL)
            return Response.json(
                { data: [{ id }] },
                { headers: { etag: '"zen"' } }
            )
        if (url === MODELS_DEV_URL)
            return Response.json(
                {
                    opencode: {
                        id: 'opencode',
                        models: { [id]: devModel(id) },
                    },
                },
                { headers: { etag: '"dev"' } }
            )
        throw new Error(`Unexpected URL: ${url}`)
    }
}

function mockContext(
    options: {
        stored?: ModelsStoreEntry
        allowNetwork?: boolean
        force?: boolean
        signal?: AbortSignal
        publications?: Array<{
            persist?: ModelsStoreEntry | null
            update?: () => void
        }>
        order?: string[]
    } = {}
): RefreshModelsContext {
    return {
        stored: options.stored,
        allowNetwork: options.allowNetwork ?? true,
        force: options.force,
        signal: options.signal ?? new AbortController().signal,
        credential: { type: 'api_key', key: 'public' },
        async publish(publication) {
            options.order?.push(
                publication.persist === undefined ? 'restore' : 'persist'
            )
            options.publications?.push(publication)
            publication.update?.()
            return true
        },
    }
}

test('stored models publish before network refresh', async () => {
    const order: string[] = []
    const runtime = createTestProvider({
        fetch: async (input, init) => {
            order.push('fetch')
            return successfulFetch()(input, init)
        },
    })
    await runtime.provider.refreshModels!(
        mockContext({
            stored: {
                models: [{ ...catalogModel('stored'), provider: PROVIDER_ID }],
                checkedAt: 0,
            },
            force: true,
            order,
        })
    )
    assert.equal(order[0], 'restore')
    assert.equal(order[1], 'fetch')
})

test('offline mode restores stored models and performs no fetch', async () => {
    let calls = 0
    const runtime = createTestProvider({
        fetch: async () => {
            calls++
            throw new Error('network should not run')
        },
    })
    await runtime.provider.refreshModels!(
        mockContext({
            allowNetwork: false,
            stored: {
                models: [{ ...catalogModel('stored'), provider: PROVIDER_ID }],
                checkedAt: 10,
            },
        })
    )
    assert.equal(calls, 0)
    assert.deepEqual(
        runtime.provider.getModels().map((model) => model.id),
        ['stored']
    )
})

test('fresh stored data skips normal refresh and force bypasses the TTL', async () => {
    let now = 1_000_000
    const calls: string[] = []
    const runtime = createTestProvider({
        fetch: successfulFetch({ calls }),
        now: () => now,
    })
    const stored = {
        models: [{ ...catalogModel('stored'), provider: PROVIDER_ID }],
        checkedAt: now - REFRESH_INTERVAL_MS + 1,
    }
    await runtime.provider.refreshModels!(mockContext({ stored }))
    assert.equal(calls.length, 0)
    await runtime.provider.refreshModels!(mockContext({ stored, force: true }))
    assert.equal(calls.length, 3)
    now += 1
})

test('successful discovery publishes and persists a complete merged catalog', async () => {
    const store = new InMemoryModelsStore()
    const runtime = createTestProvider({ fetch: successfulFetch() })
    const models = createModels({
        modelsStore: store,
        authContext: {
            env: async () => undefined,
            fileExists: async () => false,
        },
    })
    models.setProvider(runtime.provider)
    const result = await models.refresh({
        providers: [PROVIDER_ID],
        force: true,
    })
    assert.equal(result.errors.size, 0)
    assert.deepEqual(
        runtime.provider.getModels().map((model) => model.id),
        ['eligible']
    )
    const stored = await store.read(PROVIDER_ID)
    assert.deepEqual(
        stored?.models.map((model) => model.id),
        ['eligible']
    )
    assert.match(stored?.etag ?? '', /^pi-zen-free:v1:/)
})

for (const [name, fetchFn] of [
    ['one source failure', successfulFetch({ failingSource: MODELS_DEV_URL })],
    ['malformed JSON', successfulFetch({ malformedSource: PI_CATALOG_URL })],
] as const) {
    test(`${name} preserves stored models`, async () => {
        const runtime = createTestProvider({ fetch: fetchFn })
        const stored = {
            models: [{ ...catalogModel('stored'), provider: PROVIDER_ID }],
            checkedAt: 0,
        }
        await assert.rejects(
            runtime.provider.refreshModels!(
                mockContext({ stored, force: true })
            )
        )
        assert.deepEqual(
            runtime.provider.getModels().map((model) => model.id),
            ['stored']
        )
    })
}

test('an empty eligible result preserves stored models', async () => {
    const runtime = createTestProvider({
        fetch: successfulFetch({ id: 'paid' }),
    })
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === MODELS_DEV_URL)
            return Response.json({
                opencode: {
                    id: 'opencode',
                    models: {
                        paid: devModel('paid'),
                    },
                },
            })
        return successfulFetch({ id: 'paid' })(input, init)
    }
    const second = createTestProvider({
        fetch: async (input, init) => {
            const response = await fetchFn(input, init)
            if (String(input) !== MODELS_DEV_URL) return response
            return Response.json({
                opencode: {
                    id: 'opencode',
                    models: {
                        paid: {
                            ...devModel('paid'),
                            cost: { input: 0, output: 1 },
                        },
                    },
                },
            })
        },
    })
    const stored = {
        models: [{ ...catalogModel('stored'), provider: PROVIDER_ID }],
        checkedAt: 0,
    }
    await assert.rejects(
        second.provider.refreshModels!(mockContext({ stored, force: true }))
    )
    assert.deepEqual(
        second.provider.getModels().map((model) => model.id),
        ['stored']
    )
    assert.equal(runtime.provider.getModels().length, BOOTSTRAP_MODELS.length)
})

test('abort prevents publication after network work starts', async () => {
    let release!: () => void
    const delay = new Promise<void>((resolve) => {
        release = resolve
    })
    const controller = new AbortController()
    const publications: Array<{ persist?: ModelsStoreEntry | null }> = []
    const runtime = createTestProvider({ fetch: successfulFetch({ delay }) })
    const refresh = runtime.provider.refreshModels!(
        mockContext({ signal: controller.signal, publications })
    )
    controller.abort()
    release()
    await refresh
    assert.equal(publications.length, 0)
})

test('concurrent refreshes share one network operation', async () => {
    const calls: string[] = []
    let release!: () => void
    const delay = new Promise<void>((resolve) => {
        release = resolve
    })
    const runtime = createTestProvider({
        fetch: successfulFetch({ calls, delay }),
    })
    const first = runtime.provider.refreshModels!(mockContext())
    const second = runtime.provider.refreshModels!(mockContext())
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([first, second])
    assert.equal(calls.length, 3)
    assert.deepEqual(
        runtime.provider.getModels().map((model) => model.id),
        ['eligible']
    )
})

test('cancelling one coalesced refresh does not abort another caller', async () => {
    const calls: string[] = []
    let release!: () => void
    const delay = new Promise<void>((resolve) => {
        release = resolve
    })
    const runtime = createTestProvider({
        fetch: successfulFetch({ calls, delay }),
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = runtime.provider.refreshModels!(
        mockContext({ signal: firstController.signal })
    )
    const second = runtime.provider.refreshModels!(
        mockContext({ signal: secondController.signal })
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    firstController.abort()
    await first
    release()
    await second

    assert.equal(calls.length, 3)
    assert.deepEqual(
        runtime.provider.getModels().map((entry) => entry.id),
        ['eligible']
    )
})

test('a superseded slower refresh cannot overwrite newer models', async () => {
    let oldCalls = 0
    let releaseOld!: () => void
    const oldDelay = new Promise<void>((resolve) => {
        releaseOld = resolve
    })
    let oldStarted!: () => void
    const allOldStarted = new Promise<void>((resolve) => {
        oldStarted = resolve
    })
    const fetchFn: typeof fetch = async (input) => {
        const url = String(input)
        const isOld = oldCalls < 3
        if (isOld) {
            oldCalls++
            if (oldCalls === 3) oldStarted()
            await oldDelay
        }
        const id = isOld ? 'old' : 'new'
        if (url === PI_CATALOG_URL)
            return Response.json({ models: [catalogModel(id)] })
        if (url === ZEN_MODELS_URL) return Response.json({ data: [{ id }] })
        return Response.json({
            opencode: { id: 'opencode', models: { [id]: devModel(id) } },
        })
    }
    const runtime = createTestProvider({ fetch: fetchFn })
    const oldController = new AbortController()
    const oldRefresh = runtime.provider.refreshModels!(
        mockContext({ signal: oldController.signal })
    )
    await allOldStarted
    oldController.abort()
    const newRefresh = runtime.provider.refreshModels!(mockContext())
    await newRefresh
    releaseOld()
    await oldRefresh
    assert.deepEqual(
        runtime.provider.getModels().map((entry) => entry.id),
        ['new']
    )
})

test('legacy cache migrates only without native stored models', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-zen-provider-migration-'))
    const legacyPath = legacyCachePath(agentDir)
    const legacyValue = {
        version: 1,
        refreshedAt: '2026-08-20T12:00:00.000Z',
        models: [
            {
                id: 'nemotron-3.5-lightning-free',
                name: 'Legacy',
                reasoning: true,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16000,
            },
        ],
    }
    try {
        await mkdir(dirname(legacyPath), { recursive: true })
        await writeFile(legacyPath, JSON.stringify(legacyValue), 'utf8')
        const storedRuntime = createZenFreeProvider({ agentDir })
        await storedRuntime.provider.refreshModels!(
            mockContext({
                allowNetwork: false,
                stored: {
                    models: [
                        { ...catalogModel('stored'), provider: PROVIDER_ID },
                    ],
                },
            })
        )
        assert.equal(JSON.parse(await readFile(legacyPath, 'utf8')).version, 1)
        assert.deepEqual(
            storedRuntime.provider.getModels().map((entry) => entry.id),
            ['stored']
        )

        const migrationRuntime = createZenFreeProvider({ agentDir })
        const publications: Array<{ persist?: ModelsStoreEntry | null }> = []
        await migrationRuntime.provider.refreshModels!(
            mockContext({ allowNetwork: false, publications })
        )
        assert.deepEqual(
            migrationRuntime.provider.getModels().map((entry) => entry.id),
            ['nemotron-3.5-lightning-free']
        )
        assert.equal(
            publications[0]?.persist?.models[0]?.id,
            'nemotron-3.5-lightning-free'
        )
        assert.equal(publications[0]?.persist?.checkedAt, undefined)
        assert.equal(
            JSON.parse(
                await readFile(migratedLegacyCachePath(agentDir), 'utf8')
            ).version,
            1
        )
    } finally {
        await rm(agentDir, { recursive: true, force: true })
    }
})

test('credential priority is stored, PI_ZEN_FREE_KEY, OPENCODE_API_KEY, then public', async () => {
    const originalZen = process.env.PI_ZEN_FREE_KEY
    const originalOpenCode = process.env.OPENCODE_API_KEY
    process.env.PI_ZEN_FREE_KEY = 'unchanged-zen'
    process.env.OPENCODE_API_KEY = 'unchanged-opencode'
    const resolve = async (
        credential:
            | {
                  type: 'api_key'
                  key?: string
                  env?: Record<string, string>
              }
            | undefined,
        env: Record<string, string | undefined>
    ) =>
        zenFreeApiKeyAuth.resolve!({
            credential,
            signal: new AbortController().signal,
            ctx: {
                env: async (name) => env[name],
                fileExists: async () => false,
            },
        })
    try {
        assert.equal(
            (await resolve({ type: 'api_key', key: 'stored' }, {}))?.auth
                .apiKey,
            'stored'
        )
        assert.equal(
            (
                await resolve(
                    {
                        type: 'api_key',
                        env: { PI_ZEN_FREE_KEY: 'stored-env' },
                    },
                    { PI_ZEN_FREE_KEY: 'ambient' }
                )
            )?.auth.apiKey,
            'stored-env'
        )
        assert.equal(
            (await resolve(undefined, { PI_ZEN_FREE_KEY: 'zen' }))?.auth.apiKey,
            'zen'
        )
        assert.equal(
            (await resolve(undefined, { OPENCODE_API_KEY: 'opencode' }))?.auth
                .apiKey,
            'opencode'
        )
        assert.equal((await resolve(undefined, {}))?.auth.apiKey, 'public')
        assert.equal(process.env.PI_ZEN_FREE_KEY, 'unchanged-zen')
        assert.equal(process.env.OPENCODE_API_KEY, 'unchanged-opencode')
    } finally {
        if (originalZen === undefined) delete process.env.PI_ZEN_FREE_KEY
        else process.env.PI_ZEN_FREE_KEY = originalZen
        if (originalOpenCode === undefined) delete process.env.OPENCODE_API_KEY
        else process.env.OPENCODE_API_KEY = originalOpenCode
    }
})
