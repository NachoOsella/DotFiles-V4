import assert from 'node:assert/strict'
import test from 'node:test'
import {
    CatalogDecodeError,
    decodeModelsDevCatalog,
    decodePiCatalog,
    decodeZenDeploymentCatalog,
    mergeCatalogs,
} from './catalog.ts'

function piModel(id: string, overrides: Record<string, unknown> = {}) {
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
        ...overrides,
    }
}

function devModel(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: id,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 200000, output: 32000 },
        ...overrides,
    }
}

function sources(
    piModels: unknown[],
    deployedIds: string[],
    devModels: Record<string, unknown>
) {
    return {
        pi: decodePiCatalog({ models: piModels }),
        deployed: decodeZenDeploymentCatalog({
            data: deployedIds.map((id) => ({ id })),
        }),
        dev: decodeModelsDevCatalog({
            opencode: { id: 'opencode', models: devModels },
        }),
    }
}

test('three-source merge preserves protocol metadata and filters ineligible models', () => {
    const { pi, deployed, dev } = sources(
        [
            piModel('eligible'),
            piModel('muse-spark-1.2-contributor-free', {
                api: 'openai-responses',
                compat: { sessionAffinityFormat: 'openai-nosession' },
            }),
            piModel('x-preview-f-free', {
                thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
                compat: { supportsStrictMode: true },
            }),
            piModel('deepseek-v4-flash-free'),
            piModel('laguna-s-2.1-free'),
            piModel('paid-output'),
            piModel('no-tools'),
        ],
        [
            'eligible',
            'muse-spark-1.2-contributor-free',
            'x-preview-f-free',
            'deepseek-v4-flash-free',
            'laguna-s-2.1-free',
            'paid-output',
            'no-tools',
            'unknown-deployed',
        ],
        {
            eligible: devModel('eligible'),
            muse: devModel('muse-spark-1.2-contributor-free'),
            ox: devModel('x-preview-f-free'),
            deepseek: devModel('deepseek-v4-flash-free', {
                status: 'deprecated',
            }),
            laguna: devModel('laguna-s-2.1-free', { status: 'deprecated' }),
            paid: devModel('paid-output', {
                cost: { input: 0, output: 0.1 },
            }),
            tools: devModel('no-tools', { tool_call: false }),
            unknown: devModel('unknown-deployed'),
        }
    )

    const result = mergeCatalogs(pi, deployed, dev)
    assert.deepEqual(
        result.models.map((model) => model.id),
        ['eligible', 'muse-spark-1.2-contributor-free', 'x-preview-f-free']
    )

    const muse = result.models.find(
        (model) => model.id === 'muse-spark-1.2-contributor-free'
    )!
    assert.equal(muse.api, 'openai-responses')
    assert.equal(muse.compat?.sessionAffinityFormat, 'openai-nosession')

    const ox = result.models.find((model) => model.id === 'x-preview-f-free')!
    assert.deepEqual(ox.thinkingLevelMap, {
        low: 'low',
        high: 'high',
        max: 'max',
    })
    assert.equal(ox.compat?.supportsStrictMode, true)

    assert.deepEqual(
        Object.fromEntries(
            result.ignored.map(({ id, reason }) => [id, reason])
        ),
        {
            'deepseek-v4-flash-free': 'deprecated',
            'laguna-s-2.1-free': 'deprecated',
            'no-tools': 'tools_unsupported',
            'paid-output': 'paid',
            'unknown-deployed': 'missing_protocol_metadata',
        }
    )
})

test('merge reports every ignore reason', () => {
    const { pi, deployed, dev } = sources(
        [
            piModel('not-deployed'),
            piModel('missing-dev'),
            piModel('missing-price'),
            piModel('unsupported', { api: 'anthropic-messages' }),
        ],
        ['missing-protocol', 'missing-dev', 'missing-price', 'unsupported'],
        {
            'missing-protocol': devModel('missing-protocol'),
            'missing-price': devModel('missing-price', { cost: undefined }),
            unsupported: devModel('unsupported'),
        }
    )
    const reasons = new Set(
        mergeCatalogs(pi, deployed, dev).ignored.map((item) => item.reason)
    )
    assert.deepEqual(
        reasons,
        new Set([
            'not_deployed',
            'missing_protocol_metadata',
            'missing_eligibility_metadata',
            'missing_pricing',
            'unsupported_api',
        ])
    )
})

test('merge sorts models by ID and never mutates decoded sources', () => {
    const rawPi = { models: [piModel('zeta'), piModel('alpha')] }
    const rawDeployment = { data: [{ id: 'zeta' }, { id: 'alpha' }] }
    const rawDev = {
        opencode: {
            id: 'opencode',
            models: { zeta: devModel('zeta'), alpha: devModel('alpha') },
        },
    }
    const before = structuredClone({ rawPi, rawDeployment, rawDev })
    const result = mergeCatalogs(
        decodePiCatalog(rawPi),
        decodeZenDeploymentCatalog(rawDeployment),
        decodeModelsDevCatalog(rawDev)
    )
    assert.deepEqual(
        result.models.map((model) => model.id),
        ['alpha', 'zeta']
    )
    assert.deepEqual({ rawPi, rawDeployment, rawDev }, before)
})

test('duplicate IDs fail decoding in every source', () => {
    assert.throws(
        () => decodePiCatalog([piModel('same'), piModel('same')]),
        CatalogDecodeError
    )
    assert.throws(
        () =>
            decodeZenDeploymentCatalog({
                data: [{ id: 'same' }, { id: 'same' }],
            }),
        CatalogDecodeError
    )
    assert.throws(
        () =>
            decodeModelsDevCatalog({
                opencode: {
                    id: 'opencode',
                    models: {
                        first: devModel('same'),
                        second: devModel('same'),
                    },
                },
            }),
        CatalogDecodeError
    )
})

test('invalid limits, modalities, arrays, costs, and APIs fail decoding', () => {
    assert.throws(
        () => decodePiCatalog([piModel('bad', { contextWindow: 0 })]),
        /contextWindow must be positive/
    )
    assert.throws(
        () => decodePiCatalog([piModel('bad', { maxTokens: Number.NaN })]),
        /maxTokens must be finite/
    )
    assert.throws(
        () => decodePiCatalog([piModel('bad', { api: 'made-up-api' })]),
        /api .* is unknown/
    )
    assert.throws(
        () => decodePiCatalog([piModel('bad', { input: ['audio'] })]),
        /input\[0\] is unknown/
    )
    assert.throws(
        () =>
            decodePiCatalog([
                piModel('bad', {
                    compat: { maxTokensField: 'not-a-pi-value' },
                }),
            ]),
        /compat.maxTokensField is unknown/
    )
    assert.throws(
        () =>
            decodePiCatalog([
                piModel('bad', { compat: { unexpectedFlag: true } }),
            ]),
        /compat.unexpectedFlag is unknown/
    )
    assert.throws(
        () =>
            decodePiCatalog([
                piModel('bad', {
                    api: 'openai-responses',
                    compat: { maxTokensField: 'max_tokens' },
                }),
            ]),
        /compat.maxTokensField is unknown/
    )
    assert.throws(
        () => decodeZenDeploymentCatalog({ data: {} }),
        /data must be an array/
    )
    assert.throws(
        () =>
            decodeModelsDevCatalog({
                opencode: {
                    id: 'opencode',
                    models: {
                        bad: devModel('bad', {
                            modalities: { input: ['binary'], output: ['text'] },
                        }),
                    },
                },
            }),
        /modalities.input\[0\] is unknown/
    )
    assert.throws(
        () =>
            decodeModelsDevCatalog({
                opencode: {
                    id: 'opencode',
                    models: {
                        bad: devModel('bad', {
                            cost: { input: -1, output: 0 },
                        }),
                    },
                },
            }),
        /cost.input must not be negative/
    )
})
