import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Effect } from 'effect'
import { LSP_PROMPT_SNIPPET, LSP_TOOL_DESCRIPTION } from './prompt.ts'
import { LspParameters } from './schema.ts'
import { loadConfig, type LoadedConfig } from './config.ts'
import { formatDiagnostics } from './src/diagnostics.ts'
import { compactLspResult, type CompactLspDetails } from './src/format.ts'
import { LspService } from './src/service.ts'
import { createRuntime, runLsp } from './src/runtime.ts'
import type { LspOperation } from './types.ts'
import type { LspRuntime } from './src/runtime.ts'
import { LSP_INFO_CHANNEL } from '../shared/dashboard-state.ts'

const TOOL_NAME = 'lsp'
const EDIT_TOOLS = new Set(['edit', 'write'])

export default function lspExtension(pi: ExtensionAPI) {
    let runtime: LspRuntime | undefined
    let loaded: LoadedConfig | undefined
    let cwd = process.cwd()

    const getRuntime = (nextCwd: string, trusted: boolean) => {
        if (!runtime || cwd !== nextCwd) {
            void runtime?.dispose()
            cwd = nextCwd
            loaded = loadConfig(cwd, trusted)
            runtime = createRuntime(loaded.config, cwd)
        }
        return runtime
    }

    pi.on('session_start', async (_event, ctx) => {
        await runtime?.dispose()
        runtime = undefined
        cwd = ctx.cwd
        loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted())
        if (ctx.hasUI) ctx.ui.setStatus('lsp', undefined)
        publishLspStatus(pi, loaded.config.enabled, [])
    })

    pi.on('session_shutdown', async (_event, ctx) => {
        await runtime?.dispose()
        runtime = undefined
        if (ctx.hasUI) ctx.ui.setStatus('lsp', undefined)
    })

    pi.registerTool({
        name: TOOL_NAME,
        label: 'LSP',
        description: LSP_TOOL_DESCRIPTION,
        promptSnippet: LSP_PROMPT_SNIPPET,
        parameters: LspParameters,
        renderCall(args, theme, context) {
            const path = args.filePath.startsWith(context.cwd)
                ? args.filePath.slice(context.cwd.length + 1)
                : args.filePath
            const label = `${args.operation} ${path}`
            return new Text(
                theme.fg('toolTitle', theme.bold(`lsp `)) +
                    theme.fg('muted', label),
                0,
                0
            )
        },
        renderResult(result, { expanded, isPartial }, theme) {
            if (isPartial)
                return new Text(
                    theme.fg('warning', 'Querying language server...'),
                    0,
                    0
                )
            const details = result.details as CompactLspDetails | undefined
            if (!details)
                return new Text(theme.fg('muted', 'No LSP result.'), 0, 0)
            const lines = details.summary.split('\\n')
            const visible = expanded ? lines : lines.slice(0, 4)
            let text = visible.join('\\n')
            if (!expanded && lines.length > visible.length)
                text += '\\n... expand for more'
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

            const service = LspService
            const effect = importService(
                getRuntime(ctx.cwd, ctx.isProjectTrusted()),
                service,
                (lsp) =>
                    lsp.request({
                        operation,
                        filePath: params.filePath,
                        line: params.line,
                        character: params.character,
                        query: params.query,
                    })
            )
            const result = await runLsp(
                getRuntime(ctx.cwd, ctx.isProjectTrusted()),
                effect,
                {
                    signal,
                    interruptMessage: 'LSP request cancelled.',
                }
            )
            await publishRuntimeStatus(
                pi,
                getRuntime(ctx.cwd, ctx.isProjectTrusted())
            )
            const details = compactLspResult(operation, result, ctx.cwd)
            return {
                content: [{ type: 'text' as const, text: details.summary }],
                details,
            }
        },
    })

    pi.on('tool_result', async (event, ctx) => {
        if (event.isError) return
        const serviceRuntime = getRuntime(ctx.cwd, ctx.isProjectTrusted())

        if (
            EDIT_TOOLS.has(event.toolName) &&
            loaded?.config.diagnosticsAfterEdit
        ) {
            const filePath = extractFilePath(event.input, event.details)
            if (!filePath) return
            const absolutePath = resolve(ctx.cwd, filePath)
            if (!existsSync(absolutePath)) return
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
                await publishRuntimeStatus(pi, serviceRuntime)
                const text = formatDiagnostics(diagnostics, ctx.cwd)
                if (!text) return
                return {
                    content: [
                        ...event.content,
                        {
                            type: 'text' as const,
                            text: `\n\nLSP errors detected:\n${text}`,
                        },
                    ],
                    details: {
                        ...(isRecord(event.details) ? event.details : {}),
                        lspDiagnostics: diagnostics,
                    },
                }
            } catch {
                return
            }
        }

        if (event.toolName === 'read' && loaded?.config.warmOnRead) {
            const filePath = extractFilePath(event.input, event.details)
            if (!filePath) return
            const absolutePath = resolve(ctx.cwd, filePath)
            if (!existsSync(absolutePath)) return
            void runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) =>
                    lsp.touchFile(absolutePath, false)
                ),
                { signal: ctx.signal }
            )
                .then(() => publishRuntimeStatus(pi, serviceRuntime))
                .catch(() => undefined)
        }
    })

    pi.registerCommand('lsp-status', {
        description: 'Show configured and active language servers',
        handler: async (_args, ctx) => {
            const current = loadConfig(ctx.cwd, ctx.isProjectTrusted())
            const active = await runLsp(
                getRuntime(ctx.cwd, ctx.isProjectTrusted()),
                importService(
                    getRuntime(ctx.cwd, ctx.isProjectTrusted()),
                    LspService,
                    (lsp) => lsp.status
                )
            )
            const configured =
                Object.keys(current.config.servers).join(', ') || 'none'
            const lines = [
                `LSP: ${current.config.enabled ? 'enabled' : 'disabled'}`,
                `Config: ${current.path ?? 'default settings'}`,
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
            const serviceRuntime = getRuntime(ctx.cwd, ctx.isProjectTrusted())
            await runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) =>
                    lsp.restart(args.trim() || undefined)
                )
            )
            await publishRuntimeStatus(pi, serviceRuntime)
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
            const serviceRuntime = getRuntime(ctx.cwd, ctx.isProjectTrusted())
            const diagnostics = await runLsp(
                serviceRuntime,
                importService(serviceRuntime, LspService, (lsp) =>
                    lsp.diagnostics(args.trim() || undefined)
                )
            )
            const text = formatDiagnostics(diagnostics, ctx.cwd)
            ctx.ui.notify(
                text || 'No LSP errors found.',
                text ? 'warning' : 'info'
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
    currentRuntime: LspRuntime
) {
    try {
        const statuses = await runLsp(
            currentRuntime,
            importService(currentRuntime, LspService, (lsp) => lsp.status)
        )
        publishLspStatus(pi, true, statuses)
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
