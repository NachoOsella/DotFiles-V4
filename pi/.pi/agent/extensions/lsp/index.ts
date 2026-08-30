import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Effect } from 'effect'
import type { Static } from 'typebox'
import { LSP_PROMPT_SNIPPET, LSP_TOOL_DESCRIPTION } from './prompt.ts'
import { LspParameters } from './schema.ts'
import { loadConfig, type LoadedConfig } from './config.ts'
import { formatDiagnostics } from './src/diagnostics.ts'
import { compactLspResult, type CompactLspDetails } from './src/format.ts'
import { LspService } from './src/service.ts'
import { createRuntime, runLsp } from './src/runtime.ts'
import type { LspConfig, LspOperation } from './types.ts'
import type { LspRuntime } from './src/runtime.ts'
import { LSP_INFO_CHANNEL } from '../shared/dashboard-state.ts'

const TOOL_NAME = 'lsp'
const EDIT_TOOLS = new Set(['edit', 'write'])

// Process-wide singleton: parent + all subagent sessions share the same
// underlying LspRuntime / language-server processes for the same
// workspace+config. Without this, each child AgentSession would spawn its
// own tsserver (7x RAM).
const globalLifecycles = new Map<string, ReturnType<typeof createRuntimeLifecycle<LspRuntime>>>()
const globalRefCounts = new Map<string, number>()

function lifecycleKey(cwd: string, config: LspConfig): string {
    // resolve() canonicalizes the workspace; config hash keeps different
    // trust/settings from sharing a runtime incorrectly.
    return `${resolve(cwd)}::${JSON.stringify({ enabled: config.enabled, idleTimeoutMs: config.idleTimeoutMs, servers: config.servers })}`
}

function getGlobalLifecycle(cwd: string, config: LspConfig) {
    const key = lifecycleKey(cwd, config)
    let lc = globalLifecycles.get(key)
    if (!lc) {
        lc = createRuntimeLifecycle(createRuntime)
        globalLifecycles.set(key, lc)
    }
    return { lc, key }
}

interface DisposableRuntime {
    dispose(): Promise<void>
}

export function createRuntimeLifecycle<T extends DisposableRuntime>(
    create: (config: LspConfig, cwd: string) => T
) {
    let runtime: T | undefined
    let runtimeCwd: string | undefined
    let queue: Promise<void> = Promise.resolve()

    return {
        get(cwd: string, config: LspConfig): Promise<T> {
            const operation = queue.then(async () => {
                if (runtime && runtimeCwd === cwd) return runtime
                const previous = runtime
                runtime = undefined
                runtimeCwd = undefined
                await previous?.dispose()
                runtime = create(config, cwd)
                runtimeCwd = cwd
                return runtime
            })
            queue = operation.then(
                () => undefined,
                () => undefined
            )
            return operation
        },
        async dispose(): Promise<void> {
            const operation = queue.then(async () => {
                const active = runtime
                runtime = undefined
                runtimeCwd = undefined
                await active?.dispose()
            })
            queue = operation.then(
                () => undefined,
                () => undefined
            )
            await operation
        },
    }
}

export function normalizeLspArguments(
    args: unknown
): Static<typeof LspParameters> {
    if (!isRecord(args) || typeof args.filePath !== 'string')
        return args as Static<typeof LspParameters>
    if (!args.filePath.startsWith('@'))
        return args as Static<typeof LspParameters>
    return {
        ...args,
        filePath: args.filePath.slice(1),
    } as Static<typeof LspParameters>
}

export default function lspExtension(pi: ExtensionAPI) {
    let loaded: LoadedConfig | undefined
    let cwd = process.cwd()
    let currentKey: string | undefined
    const warmWork = new Set<Promise<unknown>>()
    const warmControllers = new Set<AbortController>()

    const getRuntime = async (nextCwd: string, trusted: boolean) => {
        if (!loaded || cwd !== nextCwd) {
            cwd = nextCwd
            loaded = loadConfig(cwd, trusted)
        }
        const { lc, key } = getGlobalLifecycle(cwd, loaded.config)
        if (currentKey !== key) {
            if (currentKey) {
                const prev = globalRefCounts.get(currentKey) ?? 0
                if (prev <= 1) globalRefCounts.delete(currentKey)
                else globalRefCounts.set(currentKey, prev - 1)
            }
            globalRefCounts.set(key, (globalRefCounts.get(key) ?? 0) + 1)
            currentKey = key
        }
        return lc.get(cwd, loaded.config)
    }

    const stopWarmWork = async () => {
        for (const controller of warmControllers) controller.abort()
        await Promise.allSettled(warmWork)
    }

    pi.on('session_start', async (_event, ctx) => {
        await stopWarmWork()
        cwd = ctx.cwd
        loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted())
        if (ctx.hasUI) ctx.ui.setStatus('lsp', undefined)
        publishLspStatus(pi, loaded.config.enabled, [])
    })

    pi.on('session_shutdown', async (_event, ctx) => {
        await stopWarmWork()
        if (currentKey) {
            const cnt = globalRefCounts.get(currentKey) ?? 0
            if (cnt <= 1) globalRefCounts.delete(currentKey)
            else globalRefCounts.set(currentKey, cnt - 1)
            // Keep the global lifecycle alive for reuse; the underlying
            // LspService will idle-timeout its clients. Full disposal
            // happens on process exit.
            currentKey = undefined
        }
        if (ctx.hasUI) ctx.ui.setStatus('lsp', undefined)
    })

    pi.registerTool({
        name: TOOL_NAME,
        label: 'LSP',
        description: LSP_TOOL_DESCRIPTION,
        promptSnippet: LSP_PROMPT_SNIPPET,
        parameters: LspParameters,
        prepareArguments: normalizeLspArguments,
        renderCall(args, theme, context) {
            const path = isAbsolute(args.filePath)
                ? relative(context.cwd, args.filePath)
                : args.filePath
            const label = `${args.operation} ${path}`
            return new Text(
                theme.fg('toolTitle', theme.bold(`lsp `)) +
                    theme.fg('muted', label),
                0,
                0
            )
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
            if (isPartial)
                return new Text(
                    theme.fg('warning', 'Querying language server...'),
                    0,
                    0
                )
            if (context.isError)
                return new Text(
                    theme.fg(
                        'error',
                        firstText(result.content) ?? 'LSP request failed.'
                    ),
                    0,
                    0
                )
            const details = result.details as CompactLspDetails | undefined
            if (!details)
                return new Text(theme.fg('muted', 'No LSP result.'), 0, 0)
            const lines = details.summary.split('\n')
            const visible = expanded ? lines : lines.slice(0, 4)
            let text = visible.join('\n')
            if (!expanded && lines.length > visible.length)
                text += '\n... expand for more'
            return new Text(
                theme.fg(details.resultCount === 0 ? 'muted' : 'text', text),
                0,
                0
            )
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const operation = params.operation as LspOperation
            if (
                operation !== 'documentSymbols' &&
                operation !== 'workspaceSymbols' &&
                (params.line === undefined || params.character === undefined)
            ) {
                throw new Error(
                    `${operation} requires line and character (1-based).`
                )
            }

            if (operation === 'workspaceSymbols' && !params.query?.trim()) {
                throw new Error('workspaceSymbols requires a non-empty query.')
            }
            const serviceRuntime = await getRuntime(
                ctx.cwd,
                ctx.isProjectTrusted()
            )
            const service = LspService
            const effect = importService(serviceRuntime, service, (lsp) =>
                lsp.request({
                    operation,
                    filePath: params.filePath,
                    line: params.line,
                    character: params.character,
                    query: params.query,
                    limit: params.limit,
                    offset: params.offset,
                    contextLines: params.contextLines,
                })
            )
            const result = await runLsp(serviceRuntime, effect, {
                signal,
                interruptMessage: 'LSP request cancelled.',
            })
            await publishRuntimeStatus(
                pi,
                serviceRuntime,
                loaded?.config.enabled
            )
            const details = await compactLspResult(operation, result, ctx.cwd, {
                limit: params.limit,
                offset: params.offset,
                contextLines: params.contextLines,
            })
            return {
                content: [{ type: 'text' as const, text: details.summary }],
                details,
            }
        },
    })

    pi.on('tool_result', async (event, ctx) => {
        if (event.isError) return

        if (
            EDIT_TOOLS.has(event.toolName) &&
            loaded?.config.diagnosticsAfterEdit
        ) {
            const filePath = extractFilePath(event.input, event.details)
            if (!filePath) return
            const absolutePath = resolve(ctx.cwd, filePath)
            if (!existsSync(absolutePath)) return
            const serviceRuntime = await getRuntime(
                ctx.cwd,
                ctx.isProjectTrusted()
            )
            try {
                const diagnostics = await runLsp(
                    serviceRuntime,
                    importService(serviceRuntime, LspService, (lsp) =>
                        lsp
                            .touchFile(absolutePath, true)
                            .pipe(
                                Effect.flatMap(() =>
                                    lsp.diagnostics(absolutePath)
                                )
                            )
                    ),
                    {
                        signal: ctx.signal,
                        interruptMessage: 'LSP diagnostics cancelled.',
                    }
                )
                await publishRuntimeStatus(
                    pi,
                    serviceRuntime,
                    loaded?.config.enabled
                )
                const diagnosticsResult = formatDiagnostics(
                    diagnostics,
                    ctx.cwd
                )
                if (!diagnosticsResult.text) return
                return {
                    content: [
                        ...event.content,
                        {
                            type: 'text' as const,
                            text: `\n\nLSP errors detected:\n${diagnosticsResult.text}`,
                        },
                    ],
                    details: {
                        ...(isRecord(event.details) ? event.details : {}),
                        lspDiagnostics: diagnosticsResult,
                    },
                }
            } catch {
                await publishRuntimeStatus(
                    pi,
                    serviceRuntime,
                    loaded?.config.enabled
                )
                return
            }
        }

        if (event.toolName !== 'read' || !loaded?.config.warmOnRead) return
        const filePath = extractFilePath(event.input, event.details)
        if (!filePath) return
        const absolutePath = resolve(ctx.cwd, filePath)
        if (!existsSync(absolutePath)) return
        const controller = new AbortController()
        const turnSignal = ctx.signal
        const abort = () => controller.abort()
        if (turnSignal?.aborted) controller.abort()
        else turnSignal?.addEventListener('abort', abort, { once: true })
        warmControllers.add(controller)

        let serviceRuntime: LspRuntime | undefined
        const work = (async () => {
            serviceRuntime = await getRuntime(ctx.cwd, ctx.isProjectTrusted())
            controller.signal.throwIfAborted()
            await runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) =>
                    lsp.touchFile(absolutePath, false)
                ),
                { signal: controller.signal }
            )
        })()
            .catch(() => undefined)
            .finally(async () => {
                warmControllers.delete(controller)
                warmWork.delete(work)
                turnSignal?.removeEventListener('abort', abort)
                if (serviceRuntime)
                    await publishRuntimeStatus(
                        pi,
                        serviceRuntime,
                        loaded?.config.enabled
                    )
            })
        warmWork.add(work)
    })

    pi.registerCommand('lsp-status', {
        description: 'Show configured and active language servers',
        handler: async (_args, ctx) => {
            const current = loadConfig(ctx.cwd, ctx.isProjectTrusted())
            const serviceRuntime = await getRuntime(
                ctx.cwd,
                ctx.isProjectTrusted()
            )
            const active = await runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) => lsp.status)
            )
            const configured =
                Object.keys(current.config.servers).join(', ') || 'none'
            const lines = [
                `LSP: ${current.config.enabled ? 'enabled' : 'disabled'}`,
                `Config: ${current.path ?? 'default settings'}`,
                ...(current.error ? [`Config warning: ${current.error}`] : []),
                `Configured servers: ${configured}`,
                active.length === 0
                    ? 'Active clients: none'
                    : 'Active clients:',
                ...active.map(
                    (item) =>
                        `- ${item.id} [${item.state}] root=${item.root}, documents=${item.openDocuments}`
                ),
            ]
            ctx.ui.notify(lines.join('\n'), 'info')
        },
    })

    pi.registerCommand('lsp-restart', {
        description: 'Restart active language server clients',
        handler: async (args, ctx) => {
            const serviceRuntime = await getRuntime(
                ctx.cwd,
                ctx.isProjectTrusted()
            )
            await runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) =>
                    lsp.restart(args.trim() || undefined)
                )
            )
            await publishRuntimeStatus(
                pi,
                serviceRuntime,
                loaded?.config.enabled
            )
            ctx.ui.notify(
                args.trim()
                    ? `Restarted LSP server ${args.trim()}.`
                    : 'Restarted active LSP servers.',
                'info'
            )
        },
    })

    pi.registerCommand('lsp-diagnostics', {
        description: 'Show current language-server diagnostics',
        handler: async (args, ctx) => {
            const serviceRuntime = await getRuntime(
                ctx.cwd,
                ctx.isProjectTrusted()
            )
            const diagnostics = await runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) =>
                    lsp.diagnostics(args.trim() || undefined)
                )
            )
            const diagnosticsResult = formatDiagnostics(
                diagnostics,
                ctx.cwd,
                'all'
            )
            ctx.ui.notify(
                diagnosticsResult.text || 'No LSP diagnostics found.',
                diagnosticsResult.text ? 'warning' : 'info'
            )
        },
    })
}

function publishLspStatus(
    pi: ExtensionAPI,
    enabled: boolean,
    statuses: ReadonlyArray<{ id: string; state: string }>
) {
    const servers = statuses.map((status) => `${status.id} [${status.state}]`)
    const message = !enabled
        ? 'LSP: disabled'
        : servers.length > 0
          ? `LSP: ${servers.join(', ')}`
          : 'LSP: enabled | no active server'
    pi.events.emit(LSP_INFO_CHANNEL, { enabled, message, servers })
}

async function publishRuntimeStatus(
    pi: ExtensionAPI,
    currentRuntime: LspRuntime,
    enabled = true
) {
    try {
        const statuses = await runLsp(
            currentRuntime,
            importService(currentRuntime, LspService, (lsp) => lsp.status)
        )
        publishLspStatus(pi, enabled, statuses)
    } catch {
        // Status reporting must never affect LSP requests or editing.
    }
}

function importService<A>(
    _runtime: LspRuntime,
    service: typeof LspService,
    build: (
        lsp: import('./src/service.ts').LspServiceShape
    ) => Effect.Effect<A, import('./src/errors.ts').LspError>
) {
    return Effect.gen(function* () {
        const instance = yield* service
        return yield* build(instance)
    })
}

function firstText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined
    const block = content.find(
        (value): value is { type: 'text'; text: string } =>
            isRecord(value) &&
            value.type === 'text' &&
            typeof value.text === 'string'
    )
    return block?.text
}

function extractFilePath(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        const found = findPath(value, 0)
        if (found) return found
    }
    return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findPath(value: unknown, depth: number): string | undefined {
    if (depth > 3 || !value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    for (const key of ['filePath', 'filepath', 'path', 'file']) {
        if (typeof record[key] === 'string' && record[key]) return record[key]
    }
    for (const child of Object.values(record)) {
        const found = findPath(child, depth + 1)
        if (found) return found
    }
    return undefined
}
