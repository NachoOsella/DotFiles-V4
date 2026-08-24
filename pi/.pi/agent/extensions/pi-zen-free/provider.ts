import type {
    ApiKeyAuth,
    Model,
    ModelsStoreEntry,
    Provider,
    RefreshModelsContext,
} from '@earendil-works/pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import {
    openAICompletionsApi,
    openAIResponsesApi,
} from '@earendil-works/pi-ai/compat'
import {
    decodeSourceValidators,
    encodeSourceValidators,
    fetchDiscoveryResponses,
    type SourceValidators,
} from './api.ts'
import {
    decodeModelsDevCatalog,
    decodePiCatalog,
    decodeZenDeploymentCatalog,
    mergeCatalogs,
} from './catalog.ts'
import {
    readLegacyCache,
    renameMigratedLegacyCache,
    type LegacyMigrationData,
} from './cache.ts'
import {
    FETCH_TIMEOUT_MS,
    OPENCODE_KEY_VAR,
    PROVIDER_ID,
    REFRESH_INTERVAL_MS,
    STALE_AFTER_MS,
    ZEN_BASE_URL,
    ZEN_KEY_VAR,
} from './config.ts'
import { BOOTSTRAP_MODELS } from './models.ts'
import type {
    CatalogSourceCounts,
    IgnoredCatalogModel,
    SupportedZenApi,
} from './types.ts'

export type CatalogSource = 'bootstrap' | 'legacy' | 'stored' | 'network'

export interface ZenCatalogStatus {
    source: CatalogSource
    checkedAt?: number
    stale: boolean
    modelCount: number
    ignored: readonly IgnoredCatalogModel[]
    sourceCounts?: CatalogSourceCounts
    lastError?: string
}

export interface ZenProviderRuntime {
    provider: Provider<SupportedZenApi>
    getCatalogStatus(): ZenCatalogStatus
}

export interface CreateZenProviderOptions {
    fetch?: typeof fetch
    now?: () => number
    agentDir?: string
}

export const zenFreeApiKeyAuth: ApiKeyAuth = {
    name: 'OpenCode Zen free API key',
    async check({ ctx, credential, signal }) {
        signal.throwIfAborted()
        const storedKey =
            credential?.key ??
            credential?.env?.[ZEN_KEY_VAR] ??
            credential?.env?.[OPENCODE_KEY_VAR]
        if (storedKey) return { source: 'stored credential', type: 'api_key' }
        if (await ctx.env(ZEN_KEY_VAR))
            return { source: ZEN_KEY_VAR, type: 'api_key' }
        if (await ctx.env(OPENCODE_KEY_VAR))
            return { source: OPENCODE_KEY_VAR, type: 'api_key' }
        return { source: 'public', type: 'api_key' }
    },
    async resolve({ ctx, credential, signal }) {
        signal.throwIfAborted()
        const storedKey =
            credential?.key ??
            credential?.env?.[ZEN_KEY_VAR] ??
            credential?.env?.[OPENCODE_KEY_VAR]
        if (storedKey)
            return {
                auth: { apiKey: storedKey },
                env: credential?.env,
                source: 'stored credential',
            }
        const zenKey = await ctx.env(ZEN_KEY_VAR)
        signal.throwIfAborted()
        if (zenKey) return { auth: { apiKey: zenKey }, source: ZEN_KEY_VAR }
        const opencodeKey = await ctx.env(OPENCODE_KEY_VAR)
        signal.throwIfAborted()
        if (opencodeKey)
            return { auth: { apiKey: opencodeKey }, source: OPENCODE_KEY_VAR }
        return { auth: { apiKey: 'public' }, source: 'public' }
    },
}

function cloneModels(
    models: readonly Model<SupportedZenApi>[]
): Model<SupportedZenApi>[] {
    return structuredClone(models) as Model<SupportedZenApi>[]
}

function decodeStoredModels(
    entry: Readonly<ModelsStoreEntry>
): Model<SupportedZenApi>[] {
    const decoded = decodePiCatalog({ models: entry.models })
    return [...decoded.models.values()].map((model) => {
        if (model.provider !== PROVIDER_ID)
            throw new Error(
                `Stored model ${model.id} belongs to another provider`
            )
        if (
            model.api !== 'openai-completions' &&
            model.api !== 'openai-responses'
        )
            throw new Error(`Stored model ${model.id} uses an unsupported API`)
        const { input, output, cacheRead, cacheWrite } = model.cost
        if (
            input === undefined ||
            output === undefined ||
            cacheRead === undefined ||
            cacheWrite === undefined
        )
            throw new Error(
                `Stored model ${model.id} has incomplete cost metadata`
            )
        return {
            ...model,
            name: model.name ?? model.id,
            api: model.api,
            provider: PROVIDER_ID,
            cost: {
                input,
                output,
                cacheRead,
                cacheWrite,
                ...(model.cost.tiers === undefined
                    ? {}
                    : { tiers: structuredClone(model.cost.tiers) }),
            },
        } as Model<SupportedZenApi>
    })
}

function credentialApiKey(context: RefreshModelsContext): string {
    return context.credential?.type === 'api_key' && context.credential.key
        ? context.credential.key
        : 'public'
}

function latestLastModified(validators: SourceValidators): number | undefined {
    const values = Object.values(validators)
        .map((validator) => Date.parse(validator.lastModified ?? ''))
        .filter(Number.isFinite)
    return values.length === 0 ? undefined : Math.max(...values)
}

/** Build the native provider and its catalog status reader. */
export function createZenFreeProvider(
    options: CreateZenProviderOptions = {}
): ZenProviderRuntime {
    const fetchFn = options.fetch ?? fetch
    const now = options.now ?? Date.now
    let models = cloneModels(BOOTSTRAP_MODELS)
    let status: ZenCatalogStatus = {
        source: 'bootstrap',
        stale: false,
        modelCount: models.length,
        ignored: [],
    }
    let refreshGeneration = 0
    let inFlight:
        | {
              promise: ReturnType<typeof fetchDiscoveryResponses>
              controller: AbortController
              waiters: number
              settled: boolean
          }
        | undefined

    const base = createProvider<SupportedZenApi>({
        id: PROVIDER_ID,
        name: 'OpenCode Zen Free',
        baseUrl: ZEN_BASE_URL,
        auth: { apiKey: zenFreeApiKeyAuth },
        models: BOOTSTRAP_MODELS,
        api: {
            'openai-completions': openAICompletionsApi(),
            'openai-responses': openAIResponsesApi(),
        },
    })

    const setCatalog = (
        nextModels: readonly Model<SupportedZenApi>[],
        source: CatalogSource,
        checkedAt: number | undefined,
        extra: Partial<ZenCatalogStatus> = {}
    ) => {
        models = cloneModels(nextModels)
        status = {
            source,
            checkedAt,
            stale:
                checkedAt !== undefined && now() - checkedAt > STALE_AFTER_MS,
            modelCount: models.length,
            ignored: extra.ignored ?? status.ignored,
            ...(extra.sourceCounts === undefined
                ? {}
                : { sourceCounts: extra.sourceCounts }),
            ...(extra.lastError === undefined
                ? {}
                : { lastError: extra.lastError }),
        }
    }

    const discover = (
        context: RefreshModelsContext,
        validators: SourceValidators
    ) => {
        let operation = inFlight
        if (!operation || operation.controller.signal.aborted) {
            const controller = new AbortController()
            const signal = AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(FETCH_TIMEOUT_MS),
            ])
            operation = {
                controller,
                waiters: 0,
                settled: false,
                promise: fetchDiscoveryResponses(
                    fetchFn,
                    credentialApiKey(context),
                    signal,
                    validators
                ),
            }
            inFlight = operation
            void operation.promise
                .finally(() => {
                    operation!.settled = true
                    if (inFlight === operation) inFlight = undefined
                })
                .catch(() => {})
        }

        operation.waiters += 1
        const shared = operation
        const waitForCaller = new Promise<
            Awaited<ReturnType<typeof fetchDiscoveryResponses>>
        >((resolve, reject) => {
            if (context.signal.aborted) {
                reject(context.signal.reason)
                return
            }
            const abort = () => reject(context.signal.reason)
            context.signal.addEventListener('abort', abort, { once: true })
            void shared.promise.then(resolve, reject).finally(() => {
                context.signal.removeEventListener('abort', abort)
            })
        })

        return waitForCaller.finally(() => {
            shared.waiters -= 1
            if (shared.waiters === 0 && !shared.settled)
                shared.controller.abort()
        })
    }

    const provider: Provider<SupportedZenApi> = {
        ...base,
        getModels: () => models,
        refreshModels: async (context) => {
            const generation = ++refreshGeneration
            let stored = context.stored
            let legacy: LegacyMigrationData | undefined

            if (stored) {
                try {
                    const restored = decodeStoredModels(stored)
                    if (generation !== refreshGeneration) return
                    const published = await context.publish({
                        update: () =>
                            setCatalog(restored, 'stored', stored?.checkedAt),
                    })
                    if (!published || generation !== refreshGeneration) return
                } catch (error) {
                    status = {
                        ...status,
                        lastError:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    }
                    stored = undefined
                }
            } else {
                legacy = await readLegacyCache(options.agentDir)
                if (legacy && generation === refreshGeneration) {
                    const entry: ModelsStoreEntry = {
                        // Force an online revalidation after migration because
                        // version 1 lacked authoritative protocol metadata.
                        models: legacy.models,
                    }
                    const published = await context.publish({
                        persist: entry,
                        update: () =>
                            setCatalog(
                                legacy!.models,
                                'legacy',
                                legacy!.checkedAt
                            ),
                    })
                    if (!published || generation !== refreshGeneration) return
                    await renameMigratedLegacyCache(options.agentDir)
                    stored = entry
                }
            }

            if (!context.allowNetwork || context.signal.aborted) return
            if (
                !context.force &&
                stored?.checkedAt !== undefined &&
                now() - stored.checkedAt < REFRESH_INTERVAL_MS
            )
                return

            try {
                const responses = await discover(
                    context,
                    decodeSourceValidators(stored?.etag)
                )
                context.signal.throwIfAborted()
                if (generation !== refreshGeneration) return
                const checkedAt = now()

                if (responses.unchanged) {
                    if (!stored || stored.models.length === 0)
                        throw new Error(
                            'Discovery returned 304 without a stored catalog'
                        )
                    const entry = { ...stored, checkedAt }
                    await context.publish({
                        persist: entry,
                        update: () =>
                            setCatalog(
                                decodeStoredModels(entry),
                                'network',
                                checkedAt,
                                { lastError: undefined }
                            ),
                    })
                    return
                }

                const merged = mergeCatalogs(
                    decodePiCatalog(responses.piCatalog),
                    decodeZenDeploymentCatalog(responses.deployment),
                    decodeModelsDevCatalog(responses.modelsDev)
                )
                if (merged.models.length === 0)
                    throw new Error(
                        'Discovery produced no eligible Zen free models'
                    )
                context.signal.throwIfAborted()
                if (generation !== refreshGeneration) return

                const entry: ModelsStoreEntry = {
                    models: merged.models,
                    checkedAt,
                    etag: encodeSourceValidators(responses.validators),
                    lastModified: latestLastModified(responses.validators),
                }
                const published = await context.publish({
                    persist: entry,
                    update: () =>
                        setCatalog(merged.models, 'network', checkedAt, {
                            ignored: merged.ignored,
                            sourceCounts: merged.sourceCounts,
                            lastError: undefined,
                        }),
                })
                if (published) await renameMigratedLegacyCache(options.agentDir)
            } catch (error) {
                if (context.signal.aborted || generation !== refreshGeneration)
                    return
                status = {
                    ...status,
                    lastError:
                        error instanceof Error ? error.message : String(error),
                }
                throw error
            }
        },
    }

    return {
        provider,
        getCatalogStatus: () => ({
            ...status,
            stale:
                status.checkedAt !== undefined &&
                now() - status.checkedAt > STALE_AFTER_MS,
            ignored: structuredClone(status.ignored),
            ...(status.sourceCounts === undefined
                ? {}
                : { sourceCounts: { ...status.sourceCounts } }),
        }),
    }
}
