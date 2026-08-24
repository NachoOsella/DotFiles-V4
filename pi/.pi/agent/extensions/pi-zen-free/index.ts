import type { Api, Model, ProviderHeaders } from '@earendil-works/pi-ai'
import {
    BorderedLoader,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { PROVIDER_ID } from './config.ts'
import {
    normalizeFailure,
    selectFallbackModel,
    ZenHealthTracker,
} from './health.ts'
import { createOpenCodeRequestId } from './headers.ts'
import {
    createZenFreeProvider,
    type ZenCatalogStatus,
    type ZenProviderRuntime,
} from './provider.ts'

const HEALTH_STATUS_KEY = 'zen-free-health'
const REFRESH_STATUS_KEY = 'zen-free'
const PROBE_TIMEOUT_MS = 20_000

interface ProbeAuth {
    apiKey?: string
    headers?: ProviderHeaders
    baseUrl?: string
}

export interface ProbeResult {
    ok: boolean
    status?: number
    error?: string
    payload: Record<string, unknown>
}

interface ExtensionDependencies {
    runtime?: ZenProviderRuntime
    health?: ZenHealthTracker
    fetch?: typeof fetch
}

function zenContextModel(ctx: { model?: Model<Api> }): Model<Api> | undefined {
    return ctx.model?.provider === PROVIDER_ID ? ctx.model : undefined
}

function hasHeader(headers: ProviderHeaders, expectedName: string): boolean {
    return Object.keys(headers).some(
        (name) => name.toLowerCase() === expectedName.toLowerCase()
    )
}

function textDate(timestamp: number | undefined): string {
    return timestamp === undefined
        ? 'unknown'
        : new Date(timestamp).toISOString()
}

export function formatZenStatus(
    catalog: ZenCatalogStatus,
    activeModelId: string | undefined,
    models: readonly Model<Api>[],
    health: ZenHealthTracker
): string {
    const quota = health.getProviderQuota()
    const lines = [
        `Catalog: ${catalog.source}`,
        `Checked: ${textDate(catalog.checkedAt)}`,
        `Stale: ${catalog.stale ? 'yes' : 'no'}`,
        `Active model: ${activeModelId ?? 'none'}`,
        `Provider quota: ${
            quota.active
                ? `cooldown until ${textDate(quota.cooldownUntil)}`
                : 'available'
        }`,
        'Models:',
    ]
    for (const model of [...models].sort((left, right) =>
        left.id.localeCompare(right.id)
    )) {
        const modelHealth = health.getModelHealth(model.id)
        lines.push(
            `  ${model.id}: ${modelHealth.state}${
                modelHealth.cooldownUntil
                    ? ` until ${textDate(modelHealth.cooldownUntil)}`
                    : ''
            }`
        )
    }
    if (catalog.ignored.length > 0) {
        lines.push('Ignored:')
        for (const ignored of catalog.ignored)
            lines.push(`  ${ignored.id}: ${ignored.reason}`)
    }
    if (catalog.lastError)
        lines.push(`Last refresh error: ${catalog.lastError}`)
    return lines.join('\n')
}

function chatProbePayload(modelId: string): Record<string, unknown> {
    return {
        model: modelId,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [
            {
                type: 'function',
                function: {
                    name: 'ping',
                    description: 'Return a diagnostic ping.',
                    parameters: {
                        type: 'object',
                        properties: {},
                        additionalProperties: false,
                    },
                },
            },
        ],
        tool_choice: { type: 'function', function: { name: 'ping' } },
        max_tokens: 32,
        stream: false,
    }
}

function responsesProbePayload(modelId: string): Record<string, unknown> {
    return {
        model: modelId,
        input: 'Call the ping tool.',
        tools: [
            {
                type: 'function',
                name: 'ping',
                description: 'Return a diagnostic ping.',
                parameters: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                },
            },
        ],
        tool_choice: { type: 'function', name: 'ping' },
        max_output_tokens: 32,
        stream: false,
    }
}

function containsPingToolCall(api: string, value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false
    const record = value as Record<string, unknown>
    if (api === 'openai-completions') {
        if (!Array.isArray(record.choices)) return false
        return record.choices.some((choice) => {
            if (
                typeof choice !== 'object' ||
                choice === null ||
                Array.isArray(choice)
            )
                return false
            const message = (choice as Record<string, unknown>).message
            if (
                typeof message !== 'object' ||
                message === null ||
                Array.isArray(message)
            )
                return false
            const toolCalls = (message as Record<string, unknown>).tool_calls
            return (
                Array.isArray(toolCalls) &&
                toolCalls.some((call) => {
                    if (
                        typeof call !== 'object' ||
                        call === null ||
                        Array.isArray(call)
                    )
                        return false
                    const fn = (call as Record<string, unknown>).function
                    return (
                        typeof fn === 'object' &&
                        fn !== null &&
                        !Array.isArray(fn) &&
                        (fn as Record<string, unknown>).name === 'ping'
                    )
                })
            )
        })
    }
    return (
        Array.isArray(record.output) &&
        record.output.some(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                !Array.isArray(item) &&
                (item as Record<string, unknown>).type === 'function_call' &&
                (item as Record<string, unknown>).name === 'ping'
        )
    )
}

/** Send the explicit diagnostic request without adding messages to the session. */
export async function runZenProbe(options: {
    model: Model<Api>
    auth: ProbeAuth
    sessionId: string
    signal: AbortSignal
    fetch: typeof fetch
}): Promise<ProbeResult> {
    const { model, auth, signal, fetch: fetchFn } = options
    if (model.api !== 'openai-completions' && model.api !== 'openai-responses')
        return {
            ok: false,
            error: `Unsupported probe API: ${model.api}`,
            payload: {},
        }
    const payload =
        model.api === 'openai-completions'
            ? chatProbePayload(model.id)
            : responsesProbePayload(model.id)
    const baseUrl = (auth.baseUrl ?? model.baseUrl).replace(/\/$/, '')
    const endpoint =
        model.api === 'openai-completions'
            ? `${baseUrl}/chat/completions`
            : `${baseUrl}/responses`
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-opencode-session': options.sessionId,
        'x-opencode-client': 'pi',
        'x-opencode-request': createOpenCodeRequestId(),
    }
    for (const [name, value] of Object.entries(auth.headers ?? {}))
        if (value !== null) headers[name] = value
    if (
        auth.apiKey &&
        !Object.keys(headers).some(
            (name) => name.toLowerCase() === 'authorization'
        )
    )
        headers.Authorization = `Bearer ${auth.apiKey}`

    try {
        const response = await fetchFn(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal,
        })
        const responseText = await response.text()
        let value: unknown
        try {
            value = JSON.parse(responseText) as unknown
        } catch {
            value = responseText
        }
        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                error: `Probe request failed with HTTP ${response.status}`,
                payload,
            }
        }
        if (!containsPingToolCall(model.api, value))
            return {
                ok: false,
                status: response.status,
                error: 'Probe response did not call ping',
                payload,
            }
        return { ok: true, status: response.status, payload }
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            payload,
        }
    }
}

function updateHealthStatus(
    ctx: Pick<ExtensionContext, 'ui'>,
    health: ZenHealthTracker,
    modelId: string | undefined
): void {
    const quota = health.getProviderQuota()
    if (quota.active) {
        ctx.ui.setStatus(
            HEALTH_STATUS_KEY,
            `zen quota cooldown until ${textDate(quota.cooldownUntil)}`
        )
        return
    }
    if (!modelId) {
        ctx.ui.setStatus(HEALTH_STATUS_KEY, undefined)
        return
    }
    const modelHealth = health.getModelHealth(modelId)
    ctx.ui.setStatus(
        HEALTH_STATUS_KEY,
        modelHealth.state === 'cooldown'
            ? `zen ${modelId} cooldown until ${textDate(modelHealth.cooldownUntil)}`
            : modelHealth.state === 'degraded'
              ? `zen ${modelId} degraded`
              : undefined
    )
}

async function executeProbeCommand(
    model: Model<Api>,
    ctx: ExtensionCommandContext,
    health: ZenHealthTracker,
    fetchFn: typeof fetch
): Promise<void> {
    const confirmed = await ctx.ui.confirm(
        'Zen free probe',
        `Send a quota-consuming ping probe to ${model.id}?`
    )
    if (!confirmed) {
        ctx.ui.notify('Zen probe cancelled.', 'info')
        return
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok) {
        ctx.ui.notify(`Zen probe failed: ${auth.error}`, 'error')
        return
    }

    const run = (signal: AbortSignal) =>
        runZenProbe({
            model,
            auth,
            sessionId: ctx.sessionManager.getSessionId(),
            signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(PROBE_TIMEOUT_MS),
            ]),
            fetch: fetchFn,
        })

    let result: ProbeResult | undefined
    if (ctx.mode === 'tui') {
        result = await ctx.ui.custom<ProbeResult | undefined>(
            (tui, theme, _keybindings, done) => {
                const loader = new BorderedLoader(
                    tui,
                    theme,
                    `Probing ${model.id}`
                )
                let settled = false
                loader.onAbort = () => {
                    if (!settled) {
                        settled = true
                        done(undefined)
                    }
                }
                void run(loader.signal).then((probeResult) => {
                    if (!settled) {
                        settled = true
                        done(probeResult)
                    }
                })
                return loader
            }
        )
    } else {
        result = await run(new AbortController().signal)
    }

    if (!result) {
        ctx.ui.notify('Zen probe cancelled.', 'warning')
        return
    }
    if (result.ok) {
        health.recordSuccess(model.id)
        ctx.ui.notify(`Zen probe succeeded for ${model.id}.`, 'info')
    } else {
        const category = normalizeFailure(result.error ?? '', result.status)
        health.recordFailure(model.id, category, { status: result.status })
        ctx.ui.notify(
            `Zen probe failed for ${model.id}: ${category}${
                result.error ? ` (${result.error})` : ''
            }`,
            'warning'
        )
    }
    updateHealthStatus(ctx, health, model.id)
}

export function registerZenFreeExtension(
    pi: ExtensionAPI,
    dependencies: ExtensionDependencies = {}
): { runtime: ZenProviderRuntime; health: ZenHealthTracker } {
    const runtime = dependencies.runtime ?? createZenFreeProvider()
    const health = dependencies.health ?? new ZenHealthTracker()
    const fetchFn = dependencies.fetch ?? fetch
    pi.registerProvider(runtime.provider)

    pi.on('before_provider_headers', (event, ctx) => {
        if (
            !zenContextModel(ctx) ||
            !hasHeader(event.headers, 'x-opencode-session')
        )
            return
        event.headers['x-opencode-request'] = createOpenCodeRequestId()
    })

    pi.on('after_provider_response', (event, ctx) => {
        const model = zenContextModel(ctx)
        if (!model) return
        health.recordHttpResponse(model.id, event.status, event.headers)
        updateHealthStatus(ctx, health, model.id)
    })

    pi.on('message_end', (event, ctx) => {
        const message = event.message
        if (message.role !== 'assistant') return
        const provider = message.provider ?? ctx.model?.provider
        if (provider !== PROVIDER_ID) return
        const modelId = message.model ?? ctx.model?.id
        if (!modelId) return
        if (message.stopReason === 'error') {
            const modelHealth = health.getModelHealth(modelId)
            const category = normalizeFailure(
                message.errorMessage ?? '',
                modelHealth.lastHttpStatus
            )
            health.recordFailure(modelId, category, {
                status: modelHealth.lastHttpStatus,
                retryAfter: modelHealth.retryAfter,
            })
        } else if (message.stopReason !== 'aborted') {
            health.recordSuccess(modelId)
        }
        updateHealthStatus(ctx, health, modelId)
    })

    pi.on('session_shutdown', (_event, ctx) => {
        health.clear()
        ctx.ui.setStatus(HEALTH_STATUS_KEY, undefined)
        ctx.ui.setStatus(REFRESH_STATUS_KEY, undefined)
    })

    pi.registerCommand('zen-free-refresh', {
        description: 'Refresh cached OpenCode Zen free models.',
        handler: async (_args, ctx) => {
            ctx.ui.setStatus(REFRESH_STATUS_KEY, 'refreshing')
            try {
                const result = await ctx.modelRegistry.refresh({
                    providers: [PROVIDER_ID],
                    force: true,
                })
                const error = result.errors.get(PROVIDER_ID)
                if (error)
                    ctx.ui.notify(
                        `Zen free refresh failed: ${error.message}`,
                        'warning'
                    )
                else if (result.aborted)
                    ctx.ui.notify('Zen free refresh cancelled.', 'warning')
                else
                    ctx.ui.notify(
                        `Refreshed ${runtime.provider.getModels().length} Zen free models.`,
                        'info'
                    )
            } catch (error) {
                ctx.ui.notify(
                    `Zen free refresh failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    'warning'
                )
            } finally {
                ctx.ui.setStatus(REFRESH_STATUS_KEY, undefined)
            }
        },
    })

    pi.registerCommand('zen-free-status', {
        description: 'Show Zen free catalog and model health.',
        handler: async (_args, ctx) => {
            ctx.ui.notify(
                formatZenStatus(
                    runtime.getCatalogStatus(),
                    zenContextModel(ctx)?.id,
                    runtime.provider.getModels(),
                    health
                ),
                'info'
            )
        },
    })

    pi.registerCommand('zen-free-fallback', {
        description:
            'Switch explicitly to an available Zen free fallback model.',
        handler: async (args, ctx) => {
            await ctx.waitForIdle()
            const quota = health.getProviderQuota()
            if (quota.active) {
                ctx.ui.notify(
                    `Zen free quota is cooling down until ${textDate(quota.cooldownUntil)}.`,
                    'warning'
                )
                return
            }
            const requestedId = args.trim()
            const available = ctx.modelRegistry
                .getAvailable()
                .filter((model) => model.provider === PROVIDER_ID)
            let selected: Model<Api> | undefined
            if (requestedId) {
                selected = available.find((model) => model.id === requestedId)
                if (!selected) {
                    ctx.ui.notify(
                        `Unknown Zen free model: ${requestedId}`,
                        'error'
                    )
                    return
                }
                if (health.isCoolingDown(selected.id)) {
                    ctx.ui.notify(
                        `Zen free model is cooling down: ${selected.id}`,
                        'warning'
                    )
                    return
                }
                if (selected.id === ctx.model?.id) {
                    ctx.ui.notify(
                        `${selected.id} is already active.`,
                        'warning'
                    )
                    return
                }
            } else {
                selected = selectFallbackModel(available, ctx.model?.id, health)
            }
            if (!selected) {
                ctx.ui.notify(
                    'No available Zen free fallback model.',
                    'warning'
                )
                return
            }
            if (await pi.setModel(selected))
                ctx.ui.notify(`Switched to zen-free/${selected.id}.`, 'info')
            else
                ctx.ui.notify(
                    `Could not activate zen-free/${selected.id}.`,
                    'error'
                )
        },
    })

    pi.registerCommand('zen-free-probe', {
        description: 'Run an explicit quota-consuming Zen tool-call probe.',
        handler: async (args, ctx) => {
            await ctx.waitForIdle()
            const modelId = args.trim()
            const model = ctx.modelRegistry.find(PROVIDER_ID, modelId)
            if (!modelId || !model) {
                ctx.ui.notify(
                    'Provide an exact registered Zen free model ID.',
                    'error'
                )
                return
            }
            await executeProbeCommand(model, ctx, health, fetchFn)
        },
    })

    return { runtime, health }
}

export default function zenFreeExtension(pi: ExtensionAPI): void {
    registerZenFreeExtension(pi)
}
