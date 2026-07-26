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
import { pathToFileURL } from 'node:url'
import { Context, Effect, Layer } from 'effect'
import type { Diagnostic } from 'vscode-languageserver-types'
import type {
    LspConfig,
    LspDiagnostic,
    LspOperation,
    LspRequest,
    LspStatus,
    ServerConfig,
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

export function rankMatchingServers(
    filePath: string,
    servers: Readonly<Record<string, ServerConfig>>,
    workspace?: string
): ReadonlyArray<[string, ServerConfig]> {
    const extension = extname(filePath).toLowerCase()
    const fileName = basename(filePath).toLowerCase()
    return Object.entries(servers)
        .filter(
            ([, server]) =>
                !server.disabled &&
                (!server.requiresRootMarker ||
                    hasRootMarker(filePath, server.rootMarkers, workspace)) &&
                server.extensions.some((item) => {
                    const value = item.toLowerCase()
                    return value === extension || value === fileName
                })
        )
        .sort(([, left], [, right]) =>
            (right.priority ?? 0) - (left.priority ?? 0)
        )
}

interface ClientState {
    readonly key: string
    readonly client: LspClient
    readonly serverId: string
    readonly root: string
    uses: number
    idleTimer?: ReturnType<typeof setTimeout>
}

interface StartingClient {
    promise: Promise<ClientState>
    readonly abort: () => void
    waiters: number
    settled: boolean
}

export const makeLspLayer = (config: LspConfig, cwd: string) =>
    Layer.effect(
        LspService,
        Effect.gen(function* () {
            const clients = new Map<string, ClientState>()
            const starting = new Map<string, StartingClient>()
            const failures = new Map<string, LspStatus>()
            const stopping = new Map<string, Promise<void>>()
            const rootCache = new Map<string, string>()
            const serverMatchCache = new Map<
                string,
                ReadonlyArray<[string, ServerConfig]>
            >()
            let disposed = false

            const clearIdleTimer = (state: ClientState) => {
                if (!state.idleTimer) return
                clearTimeout(state.idleTimer)
                state.idleTimer = undefined
            }

            const stopClient = async (state: ClientState) => {
                const activeStop = stopping.get(state.key)
                if (activeStop) return activeStop
                clearIdleTimer(state)
                const promise = state.client.shutdown().finally(() => {
                    if (clients.get(state.key) === state) clients.delete(state.key)
                    if (stopping.get(state.key) === promise)
                        stopping.delete(state.key)
                })
                stopping.set(state.key, promise)
                return promise
            }

            const release = (state: ClientState) => {
                state.uses = Math.max(0, state.uses - 1)
                if (state.uses > 0 || disposed) return
                clearIdleTimer(state)
                state.idleTimer = setTimeout(() => {
                    if (disposed || state.uses > 0 || clients.get(state.key) !== state)
                        return
                    void stopClient(state).catch(() => undefined)
                }, config.idleTimeoutMs)
                state.idleTimer.unref()
            }

            const acquire = (state: ClientState) => {
                clearIdleTimer(state)
                state.uses += 1
                return state
            }

            yield* Effect.addFinalizer(() =>
                Effect.promise(async () => {
                    disposed = true
                    for (const entry of starting.values()) entry.abort()
                    const active = [...clients.values()]
                    const pending = [...starting.values()]
                    await Promise.allSettled([
                        ...active.map((state) => stopClient(state)),
                        ...pending.map(({ promise }) =>
                            promise.then((state) => state.client.shutdown())
                        ),
                    ])
                    await Promise.allSettled(stopping.values())
                    clients.clear()
                    starting.clear()
                    stopping.clear()
                    failures.clear()
                    rootCache.clear()
                    serverMatchCache.clear()
                })
            )

            const findServers = (filePath: string) => {
                const key = `${dirname(filePath)}:${basename(filePath).toLowerCase()}`
                const cached = serverMatchCache.get(key)
                if (cached) return cached
                const matches = rankMatchingServers(filePath, config.servers, cwd)
                serverMatchCache.set(key, matches)
                return matches
            }

            const resolveFile = (filePath: string) =>
                isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)

            const resolveRoot = (
                serverId: string,
                filePath: string,
                markers: readonly string[]
            ) => {
                const directory = dirname(filePath)
                const cacheKey = `${serverId}:${directory}`
                const cached = rootCache.get(cacheKey)
                if (cached) return cached
                let current = directory
                while (true) {
                    if (markers.some((marker) => existsSync(join(current, marker)))) {
                        rootCache.set(cacheKey, current)
                        return current
                    }
                    if (current === cwd) break
                    const parent = dirname(current)
                    if (parent === current || !isInsideWorkspace(parent, cwd)) break
                    current = parent
                }
                rootCache.set(cacheKey, cwd)
                return cwd
            }

            const getOrStart = async (
                serverId: string,
                serverConfig: ServerConfig,
                root: string,
                signal: AbortSignal
            ) => {
                const key = `${serverId}:${root}`
                const existing = clients.get(key)
                if (existing?.client.status().state === 'connected')
                    return acquire(existing)
                if (existing) await stopClient(existing)
                const activeStop = stopping.get(key)
                if (activeStop) await activeStop

                let inflight = starting.get(key)
                if (!inflight) {
                    const controller = new AbortController()
                    const entry: StartingClient = {
                        promise: undefined as never,
                        abort: () => controller.abort(),
                        waiters: 0,
                        settled: false,
                    }
                    entry.promise = startClient({
                        serverId,
                        config: serverConfig,
                        root,
                        signal: controller.signal,
                    })
                        .then(async (client) => {
                            if (disposed) {
                                await client.shutdown()
                                throw new Error('LSP runtime was disposed during startup.')
                            }
                            const state: ClientState = {
                                key,
                                client,
                                serverId,
                                root,
                                uses: 0,
                            }
                            clients.set(key, state)
                            failures.delete(key)
                            return state
                        })
                        .finally(() => {
                            entry.settled = true
                            if (starting.get(key) === entry) starting.delete(key)
                        })
                    inflight = entry
                    starting.set(key, entry)
                }

                inflight.waiters += 1
                try {
                    return acquire(await withAbort(inflight.promise, signal))
                } finally {
                    inflight.waiters -= 1
                    if (!inflight.settled && inflight.waiters === 0)
                        inflight.abort()
                }
            }

            const getClient = (filePath: string, requiredMethod?: string) =>
                Effect.tryPromise<ClientState, LspError>({
                    try: async (signal) => {
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
                        const matches = findServers(filePath)
                        if (matches.length === 0) {
                            throw new LspServerUnavailable({
                                message: `No LSP server is configured for ${extname(filePath) || 'this file type'}.`,
                                serverId: 'unknown',
                                filePath,
                            })
                        }

                        let lastError: unknown
                        for (const [serverId, serverConfig] of matches) {
                            const root = resolveRoot(
                                serverId,
                                filePath,
                                serverConfig.rootMarkers
                            )
                            const key = `${serverId}:${root}`
                            try {
                                const state = await getOrStart(
                                    serverId,
                                    serverConfig,
                                    root,
                                    signal
                                )
                                if (
                                    requiredMethod &&
                                    !state.client.supports(requiredMethod)
                                ) {
                                    release(state)
                                    lastError = new Error(
                                        `${serverId} does not support ${requiredMethod}.`
                                    )
                                    continue
                                }
                                return state
                            } catch (cause) {
                                lastError = cause
                                failures.set(key, {
                                    id: serverId,
                                    root: relative(cwd, root) || '.',
                                    extensions: serverConfig.extensions,
                                    state: 'broken',
                                    openDocuments: 0,
                                    lastError:
                                        cause instanceof Error
                                            ? cause.message
                                            : String(cause),
                                })
                            }
                        }

                        throw new LspInitializationError({
                            message:
                                lastError instanceof Error
                                    ? lastError.message
                                    : 'Unable to start a matching language server.',
                            serverId: matches[0][0],
                            cause: lastError,
                        })
                    },
                    catch: (cause) => {
                        if (
                            cause instanceof LspDisabled ||
                            cause instanceof LspServerUnavailable ||
                            cause instanceof LspInitializationError
                        )
                            return cause
                        return new LspInitializationError({
                            message:
                                cause instanceof Error
                                    ? cause.message
                                    : String(cause),
                            serverId: findServers(filePath)[0]?.[0] ?? 'unknown',
                            cause,
                        })
                    },
                })

            const hasServer = (filePath: string) => {
                const resolved = resolveFile(filePath)
                return Effect.succeed(
                    config.enabled &&
                        isInsideWorkspace(resolved, cwd) &&
                        findServers(resolved).length > 0
                )
            }

            const touchFile = (filePath: string, waitForDiagnostics = false) =>
                Effect.gen(function* () {
                    const resolved = resolveFile(filePath)
                    const state = yield* getClient(resolved)
                    yield* Effect.tryPromise<void, LspError>({
                        try: (signal) =>
                            state.client.touchFile(
                                resolved,
                                waitForDiagnostics,
                                signal
                            ),
                        catch: (cause) =>
                            new LspRequestError({
                                message:
                                    cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                method: 'textDocument/didChange',
                                cause,
                            }),
                    }).pipe(Effect.ensuring(Effect.sync(() => release(state))))
                })

            const diagnostics = (filePath?: string) =>
                Effect.gen(function* () {
                    const target = filePath ? resolveFile(filePath) : undefined
                    const selected = target
                        ? [yield* getClient(target)]
                        : [...clients.values()]
                    const result: LspDiagnostic[] = []
                    try {
                        for (const state of selected) {
                            for (const [path, values] of state.client.diagnostics()) {
                                if (target && path !== target) continue
                                result.push(
                                    ...values.map((diagnostic) => ({
                                        ...diagnostic,
                                        filePath: path,
                                        serverId: state.client.serverId,
                                    }))
                                )
                            }
                        }
                        return result
                    } finally {
                        if (target) release(selected[0])
                    }
                })

            const request = (input: LspRequest) =>
                Effect.gen(function* () {
                    const filePath = resolveFile(input.filePath)
                    if (!existsSync(filePath)) {
                        return yield* new LspRequestError({
                            message: `File not found: ${filePath}`,
                            method: input.operation,
                            cause: undefined,
                        })
                    }
                    const method = operationMethod(input.operation)
                    const state = yield* getClient(filePath, method)
                    const params = operationParams(input, filePath)
                    return yield* Effect.tryPromise<unknown, LspError>({
                        try: async (signal) => {
                            if (input.operation !== 'workspaceSymbols')
                                await state.client.touchFile(
                                    filePath,
                                    false,
                                    signal
                                )
                            return state.client.request(
                                { method, params },
                                signal
                            )
                        },
                        catch: (cause) =>
                            new LspRequestError({
                                message:
                                    cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                method,
                                cause,
                            }),
                    }).pipe(Effect.ensuring(Effect.sync(() => release(state))))
                })

            const status = Effect.suspend(() =>
                Effect.succeed<ReadonlyArray<LspStatus>>([
                    ...[...clients.values()].map(({ client, serverId, root }) => ({
                        id: serverId,
                        root: relative(cwd, root) || '.',
                        extensions: client.extensions,
                        ...client.status(),
                    })),
                    ...failures.values(),
                ])
            )

            const restart = (serverId?: string) =>
                Effect.promise(async () => {
                    const entries = [...clients.values()].filter(
                        (value) => !serverId || value.serverId === serverId
                    )
                    await Promise.all(entries.map((state) => stopClient(state)))
                    for (const [key, value] of failures) {
                        if (!serverId || value.id === serverId) failures.delete(key)
                    }
                    rootCache.clear()
                    serverMatchCache.clear()
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
    return pathToFileURL(filePath).href
}

function hasRootMarker(
    filePath: string,
    markers: readonly string[],
    workspace?: string
): boolean {
    let current = dirname(filePath)
    while (true) {
        if (markers.some((marker) => existsSync(join(current, marker))))
            return true
        if (workspace && current === workspace) return false
        const parent = dirname(current)
        if (
            parent === current ||
            (workspace && !isInsideWorkspace(parent, workspace))
        )
            return false
        current = parent
    }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('LSP operation aborted.'))
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new Error('LSP operation aborted.'))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() =>
            signal.removeEventListener('abort', abort)
        )
    })
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
