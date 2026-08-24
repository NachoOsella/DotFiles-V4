import { MODELS_DEV_URL, PI_CATALOG_URL, ZEN_MODELS_URL } from './config.ts'

export type DiscoverySource = 'piCatalog' | 'deployment' | 'modelsDev'

export interface HttpValidator {
    etag?: string
    lastModified?: string
}

export type SourceValidators = Partial<Record<DiscoverySource, HttpValidator>>

interface SourceResponse {
    source: DiscoverySource
    status: 200 | 304
    value?: unknown
    validator: HttpValidator
}

export interface DiscoveryResponses {
    unchanged: boolean
    piCatalog?: unknown
    deployment?: unknown
    modelsDev?: unknown
    validators: SourceValidators
}

const VALIDATOR_PREFIX = 'pi-zen-free:v1:'

export function encodeSourceValidators(
    validators: SourceValidators
): string | undefined {
    if (Object.keys(validators).length === 0) return undefined
    return `${VALIDATOR_PREFIX}${JSON.stringify(validators)}`
}

export function decodeSourceValidators(
    value: string | undefined
): SourceValidators {
    if (!value?.startsWith(VALIDATOR_PREFIX)) return {}
    try {
        const parsed = JSON.parse(
            value.slice(VALIDATOR_PREFIX.length)
        ) as unknown
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
        )
            return {}
        const validators: SourceValidators = {}
        for (const source of [
            'piCatalog',
            'deployment',
            'modelsDev',
        ] as const) {
            const entry = (parsed as Record<string, unknown>)[source]
            if (
                typeof entry !== 'object' ||
                entry === null ||
                Array.isArray(entry)
            )
                continue
            const record = entry as Record<string, unknown>
            const validator: HttpValidator = {}
            if (typeof record.etag === 'string') validator.etag = record.etag
            if (typeof record.lastModified === 'string')
                validator.lastModified = record.lastModified
            if (Object.keys(validator).length > 0)
                validators[source] = validator
        }
        return validators
    } catch {
        return {}
    }
}

function requestHeaders(
    source: DiscoverySource,
    apiKey: string,
    validator: HttpValidator | undefined
): Record<string, string> {
    return {
        accept: 'application/json',
        'User-Agent': 'pi-zen-free/0.84.2 (+https://github.com/earendil-works/pi-zen-free)',
        ...(source === 'deployment'
            ? { Authorization: `Bearer ${apiKey}` }
            : {}),
        ...(validator?.etag ? { 'If-None-Match': validator.etag } : {}),
        ...(validator?.lastModified
            ? { 'If-Modified-Since': validator.lastModified }
            : {}),
    }
}

async function fetchSource(
    fetchFn: typeof fetch,
    source: DiscoverySource,
    url: string,
    apiKey: string,
    signal: AbortSignal,
    validator?: HttpValidator
): Promise<SourceResponse> {
    let response = await fetchFn(url, {
        headers: requestHeaders(source, apiKey, validator),
        signal,
    })

    // Cloudflare WAF blocks conditional requests with generic UA.
    // Retry unconditionally on 403/406 when a validator was sent.
    if (!response.ok && (response.status === 403 || response.status === 406) && validator) {
        response = await fetchFn(url, {
            headers: requestHeaders(source, apiKey, undefined),
            signal,
        })
    }
    if (response.status === 304) {
        return { source, status: 304, validator: validator ?? {} }
    }
    if (!response.ok)
        throw new Error(`${source} request failed with HTTP ${response.status}`)

    const responseValidator: HttpValidator = {}
    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')
    if (etag) responseValidator.etag = etag
    if (lastModified) responseValidator.lastModified = lastModified

    return {
        source,
        status: 200,
        value: await response.json(),
        validator: responseValidator,
    }
}

function sourceUrl(source: DiscoverySource): string {
    if (source === 'piCatalog') return PI_CATALOG_URL
    if (source === 'deployment') return ZEN_MODELS_URL
    return MODELS_DEV_URL
}

/** Fetch all required metadata sources without retrying provider requests. */
export async function fetchDiscoveryResponses(
    fetchFn: typeof fetch,
    apiKey: string,
    signal: AbortSignal,
    validators: SourceValidators = {}
): Promise<DiscoveryResponses> {
    const sources = ['piCatalog', 'deployment', 'modelsDev'] as const
    let responses = await Promise.all(
        sources.map((source) =>
            fetchSource(
                fetchFn,
                source,
                sourceUrl(source),
                apiKey,
                signal,
                validators[source]
            )
        )
    )

    if (responses.every((response) => response.status === 304)) {
        return { unchanged: true, validators }
    }

    // The native store keeps merged models, not source bodies. Refetch any
    // individually unchanged source so a mixed 200/304 result can be merged safely.
    const unchanged = responses.filter((response) => response.status === 304)
    if (unchanged.length > 0) {
        const replacements = await Promise.all(
            unchanged.map((response) =>
                fetchSource(
                    fetchFn,
                    response.source,
                    sourceUrl(response.source),
                    apiKey,
                    signal
                )
            )
        )
        const bySource = new Map(
            replacements.map((response) => [response.source, response])
        )
        responses = responses.map(
            (response) => bySource.get(response.source) ?? response
        )
    }

    const bySource = new Map(
        responses.map((response) => [response.source, response])
    )
    return {
        unchanged: false,
        piCatalog: bySource.get('piCatalog')!.value,
        deployment: bySource.get('deployment')!.value,
        modelsDev: bySource.get('modelsDev')!.value,
        validators: Object.fromEntries(
            responses.map((response) => [response.source, response.validator])
        ),
    }
}
