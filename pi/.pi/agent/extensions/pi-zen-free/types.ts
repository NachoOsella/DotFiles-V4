import type {
    Api,
    Model,
    ModelCost,
    ThinkingLevelMap,
} from '@earendil-works/pi-ai'

export type SupportedZenApi = 'openai-completions' | 'openai-responses'

export type ExternalModality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

export type ModelsDevStatus = 'alpha' | 'beta' | 'deprecated'

export type ReasoningEffort =
    | null
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | 'default'

export type ModelsDevReasoningOption =
    | { type: 'toggle' }
    | { type: 'effort'; values: ReasoningEffort[] }
    | { type: 'budget_tokens'; min?: number; max?: number }

export interface ModelsDevCost {
    input: number
    output: number
    reasoning?: number
    cache_read?: number
    cache_write?: number
    input_audio?: number
    output_audio?: number
}

export interface ModelsDevModel {
    id: string
    name?: string
    reasoning: boolean
    reasoning_options?: ModelsDevReasoningOption[]
    status?: ModelsDevStatus
    tool_call?: boolean
    structured_output?: boolean
    modalities: {
        input: ExternalModality[]
        output: ExternalModality[]
    }
    cost?: ModelsDevCost
    limit: {
        context: number
        input?: number
        output: number
    }
}

export interface ModelsDevCatalog {
    models: Map<string, ModelsDevModel>
}

export interface PiCatalogModel {
    id: string
    name?: string
    api: Api
    provider?: string
    baseUrl: string
    reasoning: boolean
    thinkingLevelMap?: ThinkingLevelMap
    input: ('text' | 'image')[]
    cost: Partial<ModelCost>
    contextWindow: number
    maxTokens: number
    headers?: Record<string, string>
    compat?: Model<Api>['compat']
}

export interface PiCatalog {
    models: Map<string, PiCatalogModel>
}

export interface ZenDeploymentCatalog {
    ids: Set<string>
}

export type CatalogIgnoreReason =
    | 'not_deployed'
    | 'missing_protocol_metadata'
    | 'missing_eligibility_metadata'
    | 'missing_pricing'
    | 'paid'
    | 'deprecated'
    | 'tools_unsupported'
    | 'unsupported_api'

export interface IgnoredCatalogModel {
    id: string
    reason: CatalogIgnoreReason
}

export interface CatalogSourceCounts {
    piCatalog: number
    deployed: number
    modelsDev: number
}

export interface CatalogMergeResult {
    models: Model<SupportedZenApi>[]
    ignored: IgnoredCatalogModel[]
    sourceCounts: CatalogSourceCounts
}
