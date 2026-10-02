import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ModelPricingResolver } from './types.ts'

const pricingResolvers = new WeakMap<object, ModelPricingResolver>()

/** Paid catalog equivalents used to estimate the value of free endpoints. */
const FREE_MODEL_PRICE_REFERENCES: Record<string, readonly [string, string][]> =
    {
        'hy3-free': [['openrouter', 'tencent/hy3']],
        'mimo-v2-pro-free': [['opencode-go', 'mimo-v2.5-pro']],
        'nemotron-3-ultra-free': [
            ['nvidia', 'nvidia/nemotron-3-ultra-550b-a55b'],
        ],
        'glm-4.7-free': [['openrouter', 'z-ai/glm-4.7']],
        'ling-2.6-flash-free': [['openrouter', 'inclusionai/ling-2.6-flash']],
        'trinity-large-preview-free': [
            ['vercel-ai-gateway', 'arcee-ai/trinity-large-preview'],
        ],
    }

/** Resolve catalog rates once per registry, preserving free-model estimates. */
export function createModelPricingResolver(
    ctx: Pick<ExtensionContext, 'modelRegistry'>
): ModelPricingResolver {
    const registry = ctx.modelRegistry as object
    const cached = pricingResolvers.get(registry)
    if (cached) return cached

    const resolver: ModelPricingResolver = (provider, modelId) => {
        const directModel = ctx.modelRegistry.find(provider, modelId)
        if (directModel) {
            // A zero-rate catalog entry is known free usage, not missing pricing.
            return { ...directModel.cost, source: 'catalog' }
        }
        if (!modelId.endsWith('-free')) return undefined

        const baseModelId = modelId.slice(0, -'-free'.length)
        const candidates = [
            ['opencode', baseModelId] as const,
            ['opencode-go', baseModelId] as const,
            ...(FREE_MODEL_PRICE_REFERENCES[modelId] ?? []),
        ]
        for (const [referenceProvider, referenceModelId] of candidates) {
            const referenceModel = ctx.modelRegistry.find(
                referenceProvider,
                referenceModelId
            )
            if (referenceModel && hasBillablePricing(referenceModel.cost)) {
                return { ...referenceModel.cost, source: 'estimated' }
            }
        }

        // Do not present a free model's zero rate as a paid reference when no
        // equivalent exists; the dashboard will show it as unknown instead.
        return undefined
    }
    pricingResolvers.set(registry, resolver)
    return resolver
}

function hasBillablePricing(pricing: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
}): boolean {
    return [
        pricing.input,
        pricing.output,
        pricing.cacheRead,
        pricing.cacheWrite,
    ].some((rate) => Number.isFinite(rate) && rate > 0)
}
