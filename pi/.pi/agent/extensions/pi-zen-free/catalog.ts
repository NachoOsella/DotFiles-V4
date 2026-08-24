import type {
    Api,
    Model,
    ModelCost,
    ModelThinkingLevel,
} from '@earendil-works/pi-ai'
import type {
    CatalogIgnoreReason,
    CatalogMergeResult,
    ExternalModality,
    ModelsDevCatalog,
    ModelsDevCost,
    ModelsDevModel,
    ModelsDevReasoningOption,
    ModelsDevStatus,
    PiCatalog,
    PiCatalogModel,
    ReasoningEffort,
    SupportedZenApi,
    ZenDeploymentCatalog,
} from './types.ts'

const KNOWN_APIS = new Set([
    'anthropic-messages',
    'openai-completions',
    'openai-responses',
    'azure-openai-responses',
    'openai-codex-responses',
    'mistral-conversations',
    'google-generative-ai',
    'google-vertex',
    'bedrock-converse-stream',
    'pi-messages',
])
const SUPPORTED_APIS = new Set<SupportedZenApi>([
    'openai-completions',
    'openai-responses',
])
const INPUT_MODALITIES = new Set<'text' | 'image'>(['text', 'image'])
const EXTERNAL_MODALITIES = new Set<ExternalModality>([
    'text',
    'image',
    'audio',
    'video',
    'pdf',
])
const OUTPUT_MODALITIES = new Set<ExternalModality>(['text', 'image', 'audio'])
const MODEL_STATUSES = new Set<ModelsDevStatus>(['alpha', 'beta', 'deprecated'])
const REASONING_EFFORTS = new Set<Exclude<ReasoningEffort, null>>([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'default',
])
const THINKING_LEVELS = new Set<ModelThinkingLevel>([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
])

export class CatalogDecodeError extends Error {
    constructor(source: string, detail: string) {
        super(`Invalid ${source} response: ${detail}`)
        this.name = 'CatalogDecodeError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRecord(
    value: unknown,
    source: string,
    path: string
): Record<string, unknown> {
    if (!isRecord(value))
        throw new CatalogDecodeError(source, `${path} must be an object`)
    return value
}

function requiredString(value: unknown, source: string, path: string): string {
    if (typeof value !== 'string' || value.trim() === '')
        throw new CatalogDecodeError(
            source,
            `${path} must be a non-empty string`
        )
    return value
}

function optionalString(
    value: unknown,
    source: string,
    path: string
): string | undefined {
    if (value === undefined) return undefined
    return requiredString(value, source, path)
}

function requiredBoolean(
    value: unknown,
    source: string,
    path: string
): boolean {
    if (typeof value !== 'boolean')
        throw new CatalogDecodeError(source, `${path} must be a boolean`)
    return value
}

function optionalBoolean(
    value: unknown,
    source: string,
    path: string
): boolean | undefined {
    if (value === undefined) return undefined
    return requiredBoolean(value, source, path)
}

function finiteNumber(value: unknown, source: string, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new CatalogDecodeError(source, `${path} must be finite`)
    return value
}

function positiveNumber(value: unknown, source: string, path: string): number {
    const number = finiteNumber(value, source, path)
    if (number <= 0)
        throw new CatalogDecodeError(source, `${path} must be positive`)
    return number
}

function nonNegativeNumber(
    value: unknown,
    source: string,
    path: string
): number {
    const number = finiteNumber(value, source, path)
    if (number < 0)
        throw new CatalogDecodeError(source, `${path} must not be negative`)
    return number
}

function optionalNonNegativeNumber(
    value: unknown,
    source: string,
    path: string
): number | undefined {
    if (value === undefined) return undefined
    return nonNegativeNumber(value, source, path)
}

function uniqueStrings<T extends string>(
    value: unknown,
    allowed: ReadonlySet<T>,
    source: string,
    path: string,
    allowEmpty = false
): T[] {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
        throw new CatalogDecodeError(
            source,
            `${path} must be ${allowEmpty ? 'an' : 'a non-empty'} array`
        )
    const result: T[] = []
    const seen = new Set<string>()
    for (let index = 0; index < value.length; index++) {
        const item = value[index]
        if (typeof item !== 'string' || !allowed.has(item as T))
            throw new CatalogDecodeError(source, `${path}[${index}] is unknown`)
        if (seen.has(item))
            throw new CatalogDecodeError(
                source,
                `${path} contains duplicate values`
            )
        seen.add(item)
        result.push(item as T)
    }
    return result
}

function assertUniqueId(ids: Set<string>, id: string, source: string): void {
    if (ids.has(id))
        throw new CatalogDecodeError(source, `duplicate model id "${id}"`)
    ids.add(id)
}

function decodeThinkingLevelMap(
    value: unknown,
    source: string,
    path: string
): PiCatalogModel['thinkingLevelMap'] {
    if (value === undefined) return undefined
    const record = requiredRecord(value, source, path)
    const result: NonNullable<PiCatalogModel['thinkingLevelMap']> = {}
    for (const [level, effort] of Object.entries(record)) {
        if (!THINKING_LEVELS.has(level as ModelThinkingLevel))
            throw new CatalogDecodeError(source, `${path}.${level} is unknown`)
        if (effort !== null && typeof effort !== 'string')
            throw new CatalogDecodeError(
                source,
                `${path}.${level} must be a string or null`
            )
        result[level as ModelThinkingLevel] = effort
    }
    return result
}

function decodeHeaders(
    value: unknown,
    source: string,
    path: string
): Record<string, string> | undefined {
    if (value === undefined) return undefined
    const record = requiredRecord(value, source, path)
    const headers: Record<string, string> = {}
    for (const [name, headerValue] of Object.entries(record)) {
        headers[requiredString(name, source, `${path} key`)] = requiredString(
            headerValue,
            source,
            `${path}.${name}`
        )
    }
    return headers
}

function validateJsonValue(value: unknown, source: string, path: string): void {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    )
        return
    if (typeof value === 'number') {
        finiteNumber(value, source, path)
        return
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) =>
            validateJsonValue(item, source, `${path}[${index}]`)
        )
        return
    }
    if (isRecord(value)) {
        for (const [key, item] of Object.entries(value))
            validateJsonValue(item, source, `${path}.${key}`)
        return
    }
    throw new CatalogDecodeError(
        source,
        `${path} contains an unsupported value`
    )
}

function decodeCompat(
    value: unknown,
    api: string,
    source: string,
    path: string
): PiCatalogModel['compat'] {
    if (value === undefined) return undefined
    const record = requiredRecord(value, source, path)
    validateJsonValue(record, source, path)

    if (api !== 'openai-completions' && api !== 'openai-responses')
        return structuredClone(record) as PiCatalogModel['compat']

    const booleanKeys = new Set(
        api === 'openai-completions'
            ? [
                  'supportsStore',
                  'supportsDeveloperRole',
                  'supportsReasoningEffort',
                  'supportsUsageInStreaming',
                  'supportsFinishReason',
                  'requiresToolResultName',
                  'requiresAssistantAfterToolResult',
                  'requiresThinkingAsText',
                  'requiresReasoningContentOnAssistantMessages',
                  'zaiToolStream',
                  'supportsThinkingTokenBudget',
                  'supportsOpenAIGrammarTools',
                  'supportsStrictMode',
                  'sendSessionAffinityHeaders',
                  'supportsLongCacheRetention',
              ]
            : [
                  'supportsDeveloperRole',
                  'supportsLongCacheRetention',
                  'supportsReasoningEffort',
                  'supportsStrictMode',
                  'supportsOpenAIGrammarTools',
                  'supportsAdditionalTools',
                  'supportsToolSearch',
                  'supportsExplicitPromptCacheMode',
              ]
    )
    const jsonKeys = new Set([
        'chatTemplateKwargs',
        'chatTemplateArgs',
        'openRouterRouting',
        'vercelGatewayRouting',
    ])
    const sessionAffinityFormats = new Set([
        'openai',
        'openai-nosession',
        'openrouter',
    ])
    const enumValues: Readonly<Record<string, ReadonlySet<string>>> =
        api === 'openai-completions'
            ? {
                  maxTokensField: new Set([
                      'max_completion_tokens',
                      'max_tokens',
                  ]),
                  thinkingFormat: new Set([
                      'openai',
                      'openrouter',
                      'deepseek',
                      'together',
                      'baseten',
                      'zai',
                      'qwen',
                      'chat-template',
                      'qwen-chat-template',
                      'string-thinking',
                      'ant-ling',
                  ]),
                  cacheControlFormat: new Set(['anthropic']),
                  deferredToolsMode: new Set(['kimi']),
                  sessionAffinityFormat: sessionAffinityFormats,
              }
            : { sessionAffinityFormat: sessionAffinityFormats }

    for (const [key, compatValue] of Object.entries(record)) {
        if (booleanKeys.has(key)) {
            requiredBoolean(compatValue, source, `${path}.${key}`)
            continue
        }
        const allowed = enumValues[key]
        if (allowed) {
            const decoded = requiredString(
                compatValue,
                source,
                `${path}.${key}`
            )
            if (!allowed.has(decoded))
                throw new CatalogDecodeError(
                    source,
                    `${path}.${key} is unknown`
                )
            continue
        }
        if (api === 'openai-completions' && jsonKeys.has(key)) continue
        throw new CatalogDecodeError(source, `${path}.${key} is unknown`)
    }
    return structuredClone(record) as PiCatalogModel['compat']
}

function decodePartialModelCost(
    value: unknown,
    source: string,
    path: string
): Partial<ModelCost> {
    const record = requiredRecord(value, source, path)
    const result: Partial<ModelCost> = {}
    for (const field of [
        'input',
        'output',
        'cacheRead',
        'cacheWrite',
    ] as const) {
        const decoded = optionalNonNegativeNumber(
            record[field],
            source,
            `${path}.${field}`
        )
        if (decoded !== undefined) result[field] = decoded
    }
    if (record.tiers !== undefined) {
        if (!Array.isArray(record.tiers))
            throw new CatalogDecodeError(
                source,
                `${path}.tiers must be an array`
            )
        result.tiers = record.tiers.map((tier, index) => {
            const tierRecord = requiredRecord(
                tier,
                source,
                `${path}.tiers[${index}]`
            )
            return {
                inputTokensAbove: nonNegativeNumber(
                    tierRecord.inputTokensAbove,
                    source,
                    `${path}.tiers[${index}].inputTokensAbove`
                ),
                input: nonNegativeNumber(
                    tierRecord.input,
                    source,
                    `${path}.tiers[${index}].input`
                ),
                output: nonNegativeNumber(
                    tierRecord.output,
                    source,
                    `${path}.tiers[${index}].output`
                ),
                cacheRead: nonNegativeNumber(
                    tierRecord.cacheRead,
                    source,
                    `${path}.tiers[${index}].cacheRead`
                ),
                cacheWrite: nonNegativeNumber(
                    tierRecord.cacheWrite,
                    source,
                    `${path}.tiers[${index}].cacheWrite`
                ),
            }
        })
    }
    return result
}

function catalogEntries(value: unknown, source: string): unknown[] {
    if (Array.isArray(value)) return value
    const root = requiredRecord(value, source, 'root')
    if (root.models !== undefined) {
        if (Array.isArray(root.models)) return root.models
        if (isRecord(root.models)) return Object.values(root.models)
        throw new CatalogDecodeError(
            source,
            'models must be an array or object'
        )
    }
    return Object.values(root)
}

export function decodePiCatalog(value: unknown): PiCatalog {
    const source = 'Pi catalog'
    const models = new Map<string, PiCatalogModel>()
    const ids = new Set<string>()
    for (const [index, entry] of catalogEntries(value, source).entries()) {
        const path = `models[${index}]`
        const record = requiredRecord(entry, source, path)
        const id = requiredString(record.id, source, `${path}.id`)
        assertUniqueId(ids, id, source)
        const api = requiredString(record.api, source, `${path}.api`)
        if (!KNOWN_APIS.has(api))
            throw new CatalogDecodeError(
                source,
                `${path}.api "${api}" is unknown`
            )
        models.set(id, {
            id,
            name: optionalString(record.name, source, `${path}.name`),
            api,
            provider: optionalString(
                record.provider,
                source,
                `${path}.provider`
            ),
            baseUrl: requiredString(record.baseUrl, source, `${path}.baseUrl`),
            reasoning: requiredBoolean(
                record.reasoning,
                source,
                `${path}.reasoning`
            ),
            thinkingLevelMap: decodeThinkingLevelMap(
                record.thinkingLevelMap,
                source,
                `${path}.thinkingLevelMap`
            ),
            input: uniqueStrings(
                record.input,
                INPUT_MODALITIES,
                source,
                `${path}.input`
            ),
            cost: decodePartialModelCost(record.cost, source, `${path}.cost`),
            contextWindow: positiveNumber(
                record.contextWindow,
                source,
                `${path}.contextWindow`
            ),
            maxTokens: positiveNumber(
                record.maxTokens,
                source,
                `${path}.maxTokens`
            ),
            headers: decodeHeaders(record.headers, source, `${path}.headers`),
            compat: decodeCompat(record.compat, api, source, `${path}.compat`),
        })
    }
    return { models }
}

export function decodeZenDeploymentCatalog(
    value: unknown
): ZenDeploymentCatalog {
    const source = 'Zen deployment catalog'
    const root = requiredRecord(value, source, 'root')
    if (!Array.isArray(root.data))
        throw new CatalogDecodeError(source, 'data must be an array')
    const ids = new Set<string>()
    root.data.forEach((entry, index) => {
        const record = requiredRecord(entry, source, `data[${index}]`)
        const id = requiredString(record.id, source, `data[${index}].id`)
        assertUniqueId(ids, id, source)
    })
    return { ids }
}

function decodeReasoningOptions(
    value: unknown,
    source: string,
    path: string
): ModelsDevReasoningOption[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value))
        throw new CatalogDecodeError(source, `${path} must be an array`)
    return value.map((entry, index) => {
        const optionPath = `${path}[${index}]`
        const record = requiredRecord(entry, source, optionPath)
        const type = requiredString(record.type, source, `${optionPath}.type`)
        if (type === 'toggle') return { type }
        if (type === 'effort') {
            if (!Array.isArray(record.values))
                throw new CatalogDecodeError(
                    source,
                    `${optionPath}.values must be an array`
                )
            const seen = new Set<ReasoningEffort>()
            const values = record.values.map((effort, effortIndex) => {
                if (
                    effort !== null &&
                    !REASONING_EFFORTS.has(
                        effort as Exclude<ReasoningEffort, null>
                    )
                )
                    throw new CatalogDecodeError(
                        source,
                        `${optionPath}.values[${effortIndex}] is unknown`
                    )
                const decoded = effort as ReasoningEffort
                if (seen.has(decoded))
                    throw new CatalogDecodeError(
                        source,
                        `${optionPath}.values contains duplicates`
                    )
                seen.add(decoded)
                return decoded
            })
            return { type, values }
        }
        if (type === 'budget_tokens') {
            const min =
                record.min === undefined
                    ? undefined
                    : finiteNumber(record.min, source, `${optionPath}.min`)
            const max =
                record.max === undefined
                    ? undefined
                    : nonNegativeNumber(record.max, source, `${optionPath}.max`)
            if (min !== undefined && min < -1)
                throw new CatalogDecodeError(
                    source,
                    `${optionPath}.min must be at least -1`
                )
            if (min !== undefined && max !== undefined && min > max)
                throw new CatalogDecodeError(
                    source,
                    `${optionPath}.min exceeds max`
                )
            return {
                type,
                ...(min === undefined ? {} : { min }),
                ...(max === undefined ? {} : { max }),
            }
        }
        throw new CatalogDecodeError(
            source,
            `${optionPath}.type "${type}" is unknown`
        )
    })
}

function decodeModelsDevCost(
    value: unknown,
    source: string,
    path: string
): ModelsDevCost | undefined {
    if (value === undefined) return undefined
    const record = requiredRecord(value, source, path)
    const cost: ModelsDevCost = {
        input: nonNegativeNumber(record.input, source, `${path}.input`),
        output: nonNegativeNumber(record.output, source, `${path}.output`),
    }
    for (const field of [
        'reasoning',
        'cache_read',
        'cache_write',
        'input_audio',
        'output_audio',
    ] as const) {
        const decoded = optionalNonNegativeNumber(
            record[field],
            source,
            `${path}.${field}`
        )
        if (decoded !== undefined) cost[field] = decoded
    }
    return cost
}

function modelsDevEntries(value: unknown): Array<[string, unknown]> {
    const source = 'models.dev catalog'
    const root = requiredRecord(value, source, 'root')
    const providerEntry = Object.entries(root).find(([key, provider]) => {
        if (key === 'opencode') return true
        return isRecord(provider) && provider.id === 'opencode'
    })
    if (!providerEntry)
        throw new CatalogDecodeError(source, 'opencode provider is missing')
    const provider = requiredRecord(providerEntry[1], source, 'opencode')
    if (Array.isArray(provider.models))
        return provider.models.map((model, index) => [String(index), model])
    if (!isRecord(provider.models))
        throw new CatalogDecodeError(
            source,
            'opencode.models must be an array or object'
        )
    return Object.entries(provider.models)
}

export function decodeModelsDevCatalog(value: unknown): ModelsDevCatalog {
    const source = 'models.dev catalog'
    const models = new Map<string, ModelsDevModel>()
    const ids = new Set<string>()
    for (const [key, entry] of modelsDevEntries(value)) {
        const path = `opencode.models.${key}`
        const record = requiredRecord(entry, source, path)
        const id = requiredString(record.id ?? key, source, `${path}.id`)
        assertUniqueId(ids, id, source)
        const modalities = requiredRecord(
            record.modalities,
            source,
            `${path}.modalities`
        )
        const limit = requiredRecord(record.limit, source, `${path}.limit`)
        const status = optionalString(record.status, source, `${path}.status`)
        if (
            status !== undefined &&
            !MODEL_STATUSES.has(status as ModelsDevStatus)
        )
            throw new CatalogDecodeError(
                source,
                `${path}.status "${status}" is unknown`
            )
        const inputLimit =
            limit.input === undefined
                ? undefined
                : positiveNumber(limit.input, source, `${path}.limit.input`)
        models.set(id, {
            id,
            name: optionalString(record.name, source, `${path}.name`),
            reasoning: requiredBoolean(
                record.reasoning,
                source,
                `${path}.reasoning`
            ),
            reasoning_options: decodeReasoningOptions(
                record.reasoning_options,
                source,
                `${path}.reasoning_options`
            ),
            status: status as ModelsDevStatus | undefined,
            tool_call: optionalBoolean(
                record.tool_call,
                source,
                `${path}.tool_call`
            ),
            structured_output: optionalBoolean(
                record.structured_output,
                source,
                `${path}.structured_output`
            ),
            modalities: {
                input: uniqueStrings(
                    modalities.input,
                    EXTERNAL_MODALITIES,
                    source,
                    `${path}.modalities.input`
                ),
                output: uniqueStrings(
                    modalities.output,
                    OUTPUT_MODALITIES,
                    source,
                    `${path}.modalities.output`
                ),
            },
            cost: decodeModelsDevCost(record.cost, source, `${path}.cost`),
            limit: {
                context: positiveNumber(
                    limit.context,
                    source,
                    `${path}.limit.context`
                ),
                ...(inputLimit === undefined ? {} : { input: inputLimit }),
                output: positiveNumber(
                    limit.output,
                    source,
                    `${path}.limit.output`
                ),
            },
        })
    }
    return { models }
}

function fullCost(
    piModel: PiCatalogModel,
    devModel: ModelsDevModel
): ModelCost {
    const devCost = devModel.cost
    const cost: ModelCost = {
        input: piModel.cost.input ?? devCost?.input ?? 0,
        output: piModel.cost.output ?? devCost?.output ?? 0,
        cacheRead: piModel.cost.cacheRead ?? devCost?.cache_read ?? 0,
        cacheWrite: piModel.cost.cacheWrite ?? devCost?.cache_write ?? 0,
    }
    if (piModel.cost.tiers !== undefined)
        cost.tiers = structuredClone(piModel.cost.tiers)
    return cost
}

function ignoredReason(
    id: string,
    piCatalog: PiCatalog,
    deployment: ZenDeploymentCatalog,
    modelsDev: ModelsDevCatalog
): CatalogIgnoreReason | undefined {
    if (!deployment.ids.has(id)) return 'not_deployed'
    const piModel = piCatalog.models.get(id)
    if (!piModel) return 'missing_protocol_metadata'
    const devModel = modelsDev.models.get(id)
    if (!devModel) return 'missing_eligibility_metadata'
    if (devModel.status === 'deprecated') return 'deprecated'
    if (!devModel.cost) return 'missing_pricing'
    if (devModel.cost.input !== 0 || devModel.cost.output !== 0) return 'paid'
    if (devModel.tool_call === false) return 'tools_unsupported'
    if (!SUPPORTED_APIS.has(piModel.api as SupportedZenApi))
        return 'unsupported_api'
    return undefined
}

export function mergeCatalogs(
    piCatalog: PiCatalog,
    deployment: ZenDeploymentCatalog,
    modelsDev: ModelsDevCatalog
): CatalogMergeResult {
    const ids = new Set([
        ...piCatalog.models.keys(),
        ...deployment.ids,
        ...modelsDev.models.keys(),
    ])
    const models: Model<SupportedZenApi>[] = []
    const ignored: CatalogMergeResult['ignored'] = []

    for (const id of [...ids].sort()) {
        const reason = ignoredReason(id, piCatalog, deployment, modelsDev)
        if (reason) {
            ignored.push({ id, reason })
            continue
        }
        const piModel = piCatalog.models.get(id)!
        const devModel = modelsDev.models.get(id)!
        models.push({
            id,
            name: piModel.name ?? devModel.name ?? id,
            api: piModel.api as SupportedZenApi,
            provider: 'zen-free',
            baseUrl: piModel.baseUrl,
            reasoning: piModel.reasoning,
            ...(piModel.thinkingLevelMap === undefined
                ? {}
                : {
                      thinkingLevelMap: structuredClone(
                          piModel.thinkingLevelMap
                      ),
                  }),
            input: [...piModel.input],
            cost: fullCost(piModel, devModel),
            contextWindow: piModel.contextWindow,
            maxTokens: piModel.maxTokens,
            ...(piModel.headers === undefined
                ? {}
                : { headers: structuredClone(piModel.headers) }),
            ...(piModel.compat === undefined
                ? {}
                : { compat: structuredClone(piModel.compat) }),
        })
    }

    return {
        models,
        ignored,
        sourceCounts: {
            piCatalog: piCatalog.models.size,
            deployed: deployment.ids.size,
            modelsDev: modelsDev.models.size,
        },
    }
}
