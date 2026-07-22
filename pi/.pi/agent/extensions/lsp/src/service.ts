import { existsSync } from 'node:fs'
import {
    basename,
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
} from 'node:path'
import { Cause, Context, Effect, Layer } from 'effect'
import type { Diagnostic } from 'vscode-languageserver-types'
import type {
    LspConfig,
    LspDiagnostic,
    LspOperation,
    LspRequest,
    LspStatus,
} from '../types.ts'
import {
    LspDisabled,
    LspInitializationError,
    LspRequestError,
    LspServerUnavailable,
    type LspError,
} from './errors.ts'
import { startClient, type LspClient } from './client.ts'

export interface LspServiceShape {
    readonly hasServer: (filePath: string) => Effect.Effect<boolean>
    readonly touchFile: (
        filePath: string,
        waitForDiagnostics?: boolean
    ) => Effect.Effect<void, LspError>
    readonly diagnostics: (
        filePath?: string
    ) => Effect.Effect<ReadonlyArray<LspDiagnostic>, LspError>
    readonly request: (request: LspRequest) => Effect.Effect<unknown, LspError>
    readonly status: Effect.Effect<ReadonlyArray<LspStatus>>
    readonly restart: (serverId?: string) => Effect.Effect<void>
}

export class LspService extends Context.Service<LspService, LspServiceShape>()(
    'pi-lsp/LspService'
) {}

interface ClientState {
    readonly client: LspClient
    readonly serverId: string
    readonly root: string
}

export const makeLspLayer = (config: LspConfig, cwd: string) =>
    Layer.effect(
        LspService,
        Effect.gen(function* () {
            const clients = new Map<string, ClientState>()
            const starting = new Map<string, Promise<LspClient>>()

            yield* Effect.addFinalizer(() =>
                Effect.promise(async () => {
                    await Promise.all(
                        [...clients.values()].map(({ client }) =>
                            client.shutdown()
                        )
                    )
                    clients.clear()
                    starting.clear()
                })
            )

            const findServer = (filePath: string) => {
                const extension = extname(filePath).toLowerCase()
                const fileName = basename(filePath).toLowerCase()
                return Object.entries(config.servers).find(
                    ([, server]) =>
                        !server.disabled &&
                        (!server.requiresRootMarker ||
                            hasRootMarker(filePath, server.rootMarkers)) &&
                        server.extensions.some((item) => {
                            const value = item.toLowerCase()
                            return value === extension || value === fileName
                        })
                )
            }

            const resolveFile = (filePath: string) => {
                const resolved = isAbsolute(filePath)
                    ? resolve(filePath)
                    : resolve(cwd, filePath)
                return resolved
            }

            const resolveRoot = (
                filePath: string,
                markers: readonly string[]
            ) => {
                let current = dirname(filePath)
                while (true) {
                    if (
                        markers.some((marker) =>
                            existsSync(join(current, marker))
                        )
                    )
                        return current
                    const parent = dirname(current)
                    if (parent === current) return cwd
                    current = parent
                }
            }

            const getClient = (filePath: string) =>
                Effect.tryPromise<LspClient, LspError>({
                    try: async () => {
                        if (!config.enabled)
                            throw new LspDisabled({
                                message: 'LSP is disabled in .pi/lsp.json.',
                            })
                        if (!isInsideWorkspace(filePath, cwd)) {
                            throw new LspServerUnavailable({
                                message:
                                    'LSP access is limited to the current workspace.',
                                serverId: 'workspace',
                                filePath,
                            })
                        }
                        const match = findServer(filePath)
                        if (!match) {
                            throw new LspServerUnavailable({
                                message: `No LSP server is configured for ${extname(filePath) || 'this file type'}.`,
                                serverId: 'unknown',
                                filePath,
                            })
                        }
                        const [serverId, serverConfig] = match
                        const root = resolveRoot(
                            filePath,
                            serverConfig.rootMarkers
                        )
                        const key = `${serverId}:${root}`
                        const existing = clients.get(key)
                        if (existing) return existing.client

                        const inflight = starting.get(key)
                        if (inflight) return inflight

                        const task = startClient({
                            serverId,
                            config: serverConfig,
                            root,
                        })
                        starting.set(key, task)
                        try {
                            const client = await task
                            clients.set(key, { client, serverId, root })
                            return client
                        } finally {
                            if (starting.get(key) === task) starting.delete(key)
                        }
                    },
                    catch: (cause) => {
                        if (
                            cause instanceof LspDisabled ||
                            cause instanceof LspServerUnavailable
                        )
                            return cause
                        const match = findServer(filePath)
                        return new LspInitializationError({
                            message:
                                cause instanceof Error
                                    ? cause.message
                                    : String(cause),
                            serverId: match?.[0] ?? 'unknown',
                            cause,
                        })
                    },
                })

            const hasServer = (filePath: string) => {
                const resolved = resolveFile(filePath)
                return Effect.succeed(
                    config.enabled &&
                        isInsideWorkspace(resolved, cwd) &&
                        findServer(resolved) !== undefined
                )
            }

            const touchFile = (filePath: string, waitForDiagnostics = false) =>
                Effect.gen(function* () {
                    const resolved = resolveFile(filePath)
                    const client = yield* getClient(resolved)
                    yield* Effect.tryPromise<void, LspError>({
                        try: () =>
                            client.touchFile(resolved, waitForDiagnostics),
                        catch: (cause) =>
                            new LspRequestError({
                                message:
                                    cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                method: 'textDocument/didChange',
                                cause,
                            }),
                    })
                })

            const diagnostics = (filePath?: string) =>
                Effect.gen(function* () {
                    const target = filePath ? resolveFile(filePath) : undefined
                    const selected = target
                        ? [yield* getClient(target)]
                        : [...clients.values()].map(({ client }) => client)
                    const result: LspDiagnostic[] = []
                    for (const client of selected) {
                        for (const [path, values] of client.diagnostics()) {
                            if (target && path !== target) continue
                            result.push(
                                ...values.map((diagnostic) => ({
                                    ...diagnostic,
                                    filePath: path,
                                    serverId: client.serverId,
                                }))
                            )
                        }
                    }
                    return result
                })

            const request = (input: LspRequest) =>
                Effect.gen(function* () {
                    const filePath = resolveFile(input.filePath)
                    if (!existsSync(filePath)) {
                        return yield* Effect.failCause(
                            Cause.fail(
                                new LspRequestError({
                                    message: `File not found: ${filePath}`,
                                    method: input.operation,
                                    cause: undefined,
                                })
                            )
                        )
                    }
                    const client = yield* getClient(filePath)
                    const method = operationMethod(input.operation)
                    const params = operationParams(input, filePath)
                    return yield* Effect.tryPromise<unknown, LspError>({
                        try: () => client.request({ method, params }),
                        catch: (cause) =>
                            new LspRequestError({
                                message:
                                    cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                method,
                                cause,
                            }),
                    })
                })

            const status = Effect.suspend(() =>
                Effect.succeed<ReadonlyArray<LspStatus>>(
                    [...clients.values()].map(({ client, serverId, root }) => ({
                        id: serverId,
                        root: relative(cwd, root) || '.',
                        extensions: client.extensions,
                        ...client.status(),
                    }))
                )
            )

            const restart = (serverId?: string) =>
                Effect.promise(async () => {
                    const entries = [...clients.entries()].filter(
                        ([, value]) => !serverId || value.serverId === serverId
                    )
                    await Promise.all(
                        entries.map(async ([key, value]) => {
                            await value.client.shutdown()
                            clients.delete(key)
                        })
                    )
                })

            return LspService.of({
                hasServer,
                touchFile,
                diagnostics,
                request,
                status,
                restart,
            })
        })
    )

function operationMethod(operation: LspOperation): string {
    switch (operation) {
        case 'definition':
            return 'textDocument/definition'
        case 'references':
            return 'textDocument/references'
        case 'hover':
            return 'textDocument/hover'
        case 'documentSymbols':
            return 'textDocument/documentSymbol'
        case 'workspaceSymbols':
            return 'workspace/symbol'
        case 'implementation':
            return 'textDocument/implementation'
    }
}

function operationParams(input: LspRequest, filePath: string): unknown {
    const uri = pathToUri(filePath)
    if (input.operation === 'workspaceSymbols')
        return { query: input.query ?? '' }
    if (input.operation === 'documentSymbols') return { textDocument: { uri } }
    return {
        textDocument: { uri },
        position: {
            line: (input.line ?? 1) - 1,
            character: (input.character ?? 1) - 1,
        },
        ...(input.operation === 'references'
            ? { context: { includeDeclaration: true } }
            : {}),
    }
}

function pathToUri(filePath: string): string {
    return new URL(`file://${filePath.split('\\').join('/')}`).href
}

function hasRootMarker(filePath: string, markers: readonly string[]): boolean {
    let current = dirname(filePath)
    while (true) {
        if (markers.some((marker) => existsSync(join(current, marker)))) {
            return true
        }
        const parent = dirname(current)
        if (parent === current) return false
        current = parent
    }
}

function isInsideWorkspace(filePath: string, workspace: string): boolean {
    const value = relative(workspace, filePath)
    return (
        value === '' ||
        (!value.startsWith('..\\') &&
            !value.startsWith('../') &&
            value !== '..')
    )
}
