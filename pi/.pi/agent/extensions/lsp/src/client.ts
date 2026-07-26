import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    CancellationTokenSource,
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { ServerConfig } from '../types.ts'
import { languageIdForPath } from './language.ts'

const INITIALIZE_TIMEOUT_MS = 45_000
const REQUEST_TIMEOUT_MS = 8_000
const DIAGNOSTIC_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 2_000
const MAX_OPEN_DOCUMENTS = 64
const MAX_STDERR_CHARS = 8_000
const INCREMENTAL_SYNC = 2

export interface ClientRequest {
    readonly method: string
    readonly params: unknown
}

export interface LspClient {
    readonly serverId: string
    readonly root: string
    readonly extensions: readonly string[]
    readonly status: () => ClientStatus
    readonly supports: (method: string) => boolean
    readonly touchFile: (
        filePath: string,
        waitForDiagnostics: boolean,
        signal?: AbortSignal
    ) => Promise<void>
    readonly diagnostics: () => ReadonlyMap<string, readonly Diagnostic[]>
    readonly request: (
        request: ClientRequest,
        signal?: AbortSignal
    ) => Promise<unknown>
    readonly shutdown: () => Promise<void>
}

export interface ClientStatus {
    readonly state: 'connected' | 'broken'
    readonly openDocuments: number
    readonly lastError?: string
}

interface OpenDocument {
    version: number
    text: string
    lastUsed: number
}

interface ServerCapabilities {
    readonly textDocumentSync?:
        | number
        | { readonly change?: number; readonly openClose?: boolean }
    readonly diagnosticProvider?: unknown
    readonly definitionProvider?: unknown
    readonly referencesProvider?: unknown
    readonly hoverProvider?: unknown
    readonly implementationProvider?: unknown
    readonly documentSymbolProvider?: unknown
    readonly workspaceSymbolProvider?: unknown
}

export async function startClient(input: {
    serverId: string
    config: ServerConfig
    root: string
    signal?: AbortSignal
}): Promise<LspClient> {
    const [command, ...args] = input.config.command
    if (!command)
        throw new Error(`LSP server ${input.serverId} has an empty command.`)

    const child = spawn(command, args, {
        cwd: input.root,
        env: { ...process.env, ...input.config.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS)
    })
    try {
        await waitForSpawn(child, input.signal)
    } catch (error) {
        await terminateProcess(child)
        throw enrichError(error, input.serverId, command, input.root, stderr)
    }

    const connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
    )
    let state: ClientStatus = { state: 'connected', openDocuments: 0 }
    const documents = new Map<string, OpenDocument>()
    const documentQueues = new Map<string, Promise<void>>()
    const pushedDiagnostics = new Map<string, Diagnostic[]>()
    const diagnosticPublishedAt = new Map<string, number>()
    let operationQueue = Promise.resolve()
    let capabilities: ServerCapabilities = {}
    let shutdownPromise: Promise<void> | undefined
    let expectedExit = false
    let disposed = false

    const processFailure = new Promise<never>((_, reject) => {
        child.once('error', (error) => reject(error))
        child.once('exit', (code, signal) => {
            if (!expectedExit) {
                const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
                reject(new Error(`LSP process exited with ${detail}.${stderrSuffix(stderr)}`))
            }
        })
    })

    connection.onNotification(
        'textDocument/publishDiagnostics',
        (params: { uri: string; diagnostics?: Diagnostic[] }) => {
            const filePath = filePathFromUri(params.uri)
            setDiagnostics(filePath, params.diagnostics ?? [])
        }
    )
    connection.onRequest(
        'workspace/configuration',
        async (params: { items?: readonly { section?: string }[] }) =>
            (params.items ?? []).map((item) =>
                getConfigurationValue(input.config.initialization, item.section)
            )
    )
    connection.onRequest('workspace/workspaceFolders', async () => [
        { name: 'workspace', uri: pathToFileURL(input.root).href },
    ])
    connection.onRequest('window/workDoneProgress/create', async () => null)
    connection.onRequest('workspace/diagnostic/refresh', async () => null)
    connection.listen()

    try {
        const initialized = await withAbort(
            withTimeout(
                Promise.race([
                    connection.sendRequest<{ capabilities?: ServerCapabilities }>(
                        'initialize',
                        {
                            processId: process.pid,
                            rootUri: pathToFileURL(input.root).href,
                            workspaceFolders: [
                                {
                                    name: 'workspace',
                                    uri: pathToFileURL(input.root).href,
                                },
                            ],
                            initializationOptions: input.config.initialization,
                            capabilities: {
                                workspace: { configuration: true, symbol: {} },
                                textDocument: {
                                    synchronization: {
                                        dynamicRegistration: false,
                                        didOpen: true,
                                        didChange: true,
                                        didClose: true,
                                    },
                                    definition: { linkSupport: true },
                                    implementation: { linkSupport: true },
                                    publishDiagnostics: { versionSupport: false },
                                    diagnostic: {
                                        dynamicRegistration: false,
                                        relatedDocumentSupport: true,
                                    },
                                },
                                general: { positionEncodings: ['utf-16'] },
                                window: { workDoneProgress: true },
                            },
                        }
                    ),
                    processFailure,
                ]),
                INITIALIZE_TIMEOUT_MS,
                'LSP initialize timed out'
            ),
            input.signal,
            'LSP initialization aborted'
        )
        capabilities = initialized.capabilities ?? {}
        await connection.sendNotification('initialized', {})
        if (input.config.initialization !== undefined) {
            await connection.sendNotification('workspace/didChangeConfiguration', {
                settings: input.config.initialization,
            })
        }
    } catch (error) {
        disposed = true
        connection.dispose()
        await terminateProcess(child)
        throw enrichError(error, input.serverId, command, input.root, stderr)
    }

    const syncKind = getSyncKind(capabilities.textDocumentSync)
    const openClose = getOpenClose(capabilities.textDocumentSync)
    child.once('exit', (code, signal) => {
        if (expectedExit || disposed) return
        state = {
            ...state,
            state: 'broken',
            lastError: `LSP process exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.${stderrSuffix(stderr)}`,
        }
        disposed = true
        connection.dispose()
        documents.clear()
        documentQueues.clear()
        pushedDiagnostics.clear()
        diagnosticPublishedAt.clear()
    })

    const client: LspClient = {
        serverId: input.serverId,
        root: input.root,
        extensions: input.config.extensions,
        status: () => ({ ...state, openDocuments: documents.size }),
        supports: (method) => supportsMethod(capabilities, method),
        touchFile: (filePath, waitForDiagnostics, signal) =>
            enqueueOperation(() => enqueueDocument(filePath, async () => {
                assertConnected()
                throwIfAborted(signal)
                const text = await readFile(filePath, { encoding: 'utf8', signal })
                const uri = pathToFileURL(filePath).href
                const current = documents.get(filePath)
                const after = diagnosticPublishedAt.get(filePath) ?? 0

                if (!current) {
                    if (openClose) await connection.sendNotification('textDocument/didOpen', {
                        textDocument: {
                            uri,
                            languageId: languageIdForPath(filePath),
                            version: 0,
                            text,
                        },
                    })
                    documents.set(filePath, {
                        version: 0,
                        text,
                        lastUsed: Date.now(),
                    })
                    await evictDocuments(filePath)
                } else if (current.text !== text) {
                    const version = current.version + 1
                    if (syncKind !== 0) await connection.sendNotification('textDocument/didChange', {
                        textDocument: { uri, version },
                        contentChanges:
                            syncKind === INCREMENTAL_SYNC
                                ? [
                                      {
                                          range: {
                                              start: { line: 0, character: 0 },
                                              end: endPosition(current.text),
                                          },
                                          text,
                                      },
                                  ]
                                : [{ text }],
                    })
                    documents.set(filePath, {
                        version,
                        text,
                        lastUsed: Date.now(),
                    })
                } else {
                    current.lastUsed = Date.now()
                }

                if (
                    waitForDiagnostics &&
                    (!current || current.text !== text || !pushedDiagnostics.has(filePath))
                )
                    await waitForDiagnosticsResult(filePath, uri, after, signal)
            })),
        diagnostics: () =>
            new Map(
                [...pushedDiagnostics.entries()].map(([filePath, values]) => [
                    filePath,
                    [...values],
                ])
            ),
        request: ({ method, params }, signal) => enqueueOperation(async () => {
            assertConnected()
            if (!supportsMethod(capabilities, method))
                throw new Error(`${input.serverId} does not support ${method}.`)
            if (method === 'textDocument/diagnostic' && capabilities.diagnosticProvider) {
                const result = await cancellableRequest<{ items?: Diagnostic[] } | null>(
                    method,
                    params,
                    REQUEST_TIMEOUT_MS,
                    signal
                )
                const uri = (params as { textDocument: { uri: string } })
                    .textDocument.uri
                const filePath = filePathFromUri(uri)
                setDiagnostics(filePath, result?.items ?? [])
                return result
            }
            return cancellableRequest(method, params, REQUEST_TIMEOUT_MS, signal)
        }),
        shutdown: () => {
            if (shutdownPromise) return shutdownPromise
            shutdownPromise = shutdownClient()
            return shutdownPromise
        },
    }
    return client

    function assertConnected() {
        if (disposed || state.state === 'broken')
            throw new Error(state.lastError ?? 'LSP client is not connected.')
    }

    function enqueueOperation<T>(task: () => Promise<T>): Promise<T> {
        const current = operationQueue.catch(() => undefined).then(task)
        operationQueue = current.then(() => undefined, () => undefined)
        return current
    }

    function enqueueDocument(filePath: string, task: () => Promise<void>) {
        const previous = documentQueues.get(filePath) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(task)
        documentQueues.set(filePath, current)
        return current.finally(() => {
            if (documentQueues.get(filePath) === current)
                documentQueues.delete(filePath)
        })
    }

    async function evictDocuments(except: string) {
        while (documents.size > MAX_OPEN_DOCUMENTS) {
            const candidate = [...documents.entries()]
                .filter(([path]) => path !== except)
                .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0]
            if (!candidate) return
            const [filePath] = candidate
            if (openClose) await connection.sendNotification('textDocument/didClose', {
                textDocument: { uri: pathToFileURL(filePath).href },
            })
            documents.delete(filePath)
            pushedDiagnostics.delete(filePath)
            diagnosticPublishedAt.delete(filePath)
        }
    }

    async function waitForDiagnosticsResult(
        filePath: string,
        uri: string,
        after: number,
        signal?: AbortSignal
    ) {
        if (capabilities.diagnosticProvider) {
            try {
                const result = await cancellableRequest<{ items?: Diagnostic[] } | null>(
                    'textDocument/diagnostic',
                    { textDocument: { uri } },
                    DIAGNOSTIC_TIMEOUT_MS,
                    signal
                )
                setDiagnostics(filePath, result?.items ?? [])
            } catch {
                // Push diagnostics remain useful when pull diagnostics are unavailable.
            }
            return
        }
        await waitUntil(
            () => (diagnosticPublishedAt.get(filePath) ?? 0) > after,
            DIAGNOSTIC_TIMEOUT_MS,
            signal
        )
    }

    async function cancellableRequest<T = unknown>(
        method: string,
        params: unknown,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<T> {
        const source = new CancellationTokenSource()
        const abort = () => source.cancel()
        signal?.addEventListener('abort', abort, { once: true })
        try {
            return await withTimeout(
                connection.sendRequest<T>(method, params, source.token),
                timeoutMs,
                `${method} timed out`,
                () => source.cancel()
            )
        } finally {
            signal?.removeEventListener('abort', abort)
            source.dispose()
            throwIfAborted(signal)
        }
    }

    function setDiagnostics(filePath: string, values: Diagnostic[]) {
        const previousPublication = diagnosticPublishedAt.get(filePath) ?? 0
        pushedDiagnostics.delete(filePath)
        diagnosticPublishedAt.delete(filePath)
        pushedDiagnostics.set(filePath, values)
        diagnosticPublishedAt.set(
            filePath,
            Math.max(Date.now(), previousPublication + 1)
        )
        while (pushedDiagnostics.size > 128) {
            const oldest = pushedDiagnostics.keys().next().value
            if (oldest === undefined) break
            pushedDiagnostics.delete(oldest)
            diagnosticPublishedAt.delete(oldest)
        }
    }

    async function shutdownClient() {
        if (disposed) return
        expectedExit = true
        try {
            await withTimeout(
                connection.sendRequest('shutdown', null),
                SHUTDOWN_TIMEOUT_MS,
                'LSP shutdown timed out'
            )
        } catch {
            // Cleanup remains required when the process already exited.
        }
        try {
            for (const filePath of openClose ? documents.keys() : []) {
                await connection.sendNotification('textDocument/didClose', {
                    textDocument: { uri: pathToFileURL(filePath).href },
                })
            }
            await connection.sendNotification('exit')
        } catch {
            // Ignore protocol errors while shutting down.
        }
        disposed = true
        connection.dispose()
        await terminateProcess(child)
        documents.clear()
        documentQueues.clear()
        pushedDiagnostics.clear()
        diagnosticPublishedAt.clear()
    }
}

function supportsMethod(capabilities: ServerCapabilities, method: string): boolean {
    const capability: Readonly<Record<string, unknown>> = {
        'textDocument/definition': capabilities.definitionProvider,
        'textDocument/references': capabilities.referencesProvider,
        'textDocument/hover': capabilities.hoverProvider,
        'textDocument/implementation': capabilities.implementationProvider,
        'textDocument/documentSymbol': capabilities.documentSymbolProvider,
        'workspace/symbol': capabilities.workspaceSymbolProvider,
        'textDocument/diagnostic': capabilities.diagnosticProvider,
    }
    return !(method in capability) || Boolean(capability[method])
}

function getSyncKind(value: ServerCapabilities['textDocumentSync']): number {
    if (typeof value === 'number') return value
    return value?.change ?? 0
}

function getOpenClose(value: ServerCapabilities['textDocumentSync']): boolean {
    if (typeof value === 'number') return value !== 0
    return value?.openClose === true
}

function endPosition(text: string) {
    const lines = text.split(/\r\n|\r|\n/)
    return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

function filePathFromUri(uri: string): string {
    try {
        return fileURLToPath(uri)
    } catch {
        return uri
    }
}

function getConfigurationValue(value: unknown, section?: string): unknown {
    if (!section) return value ?? null
    return (
        section.split('.').reduce<unknown>((current, key) => {
            if (!current || typeof current !== 'object') return undefined
            return (current as Record<string, unknown>)[key]
        }, value) ?? null
    )
}

function enrichError(
    error: unknown,
    serverId: string,
    command: string,
    root: string,
    stderr: string
) {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(
        `Failed to start LSP ${serverId} (${command}) in ${root}: ${message}${stderrSuffix(stderr)}`,
        { cause: error }
    )
}

function stderrSuffix(stderr: string): string {
    const value = stderr.trim()
    return value ? ` stderr: ${value}` : ''
}

async function terminateProcess(child: ChildProcessWithoutNullStreams) {
    if (
        child.pid === undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
    )
        return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    signalProcessTree(child, 'SIGTERM')
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
            signalProcessTree(child, 'SIGKILL')
    }, 5_000)
    timer.unref()
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
        exited,
        new Promise<void>((resolve) => {
            fallbackTimer = setTimeout(resolve, 5_500)
            fallbackTimer.unref()
        }),
    ])
    clearTimeout(timer)
    if (fallbackTimer) clearTimeout(fallbackTimer)
}

function signalProcessTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals
) {
    try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
            process.kill(-child.pid, signal)
            return
        }
    } catch {
        // Fall back to the direct child when its process group is gone.
    }
    try {
        child.kill(signal)
    } catch {
        // Process termination is best-effort.
    }
}

function waitForSpawn(
    child: ChildProcessWithoutNullStreams,
    signal?: AbortSignal
): Promise<void> {
    if (child.pid !== undefined) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            child.removeListener('spawn', spawned)
            child.removeListener('error', failed)
            signal?.removeEventListener('abort', aborted)
        }
        const spawned = () => {
            cleanup()
            resolve()
        }
        const failed = (error: Error) => {
            cleanup()
            reject(error)
        }
        const aborted = () => {
            cleanup()
            reject(new Error('LSP initialization aborted'))
        }
        child.once('spawn', spawned)
        child.once('error', failed)
        signal?.addEventListener('abort', aborted, { once: true })
    })
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('LSP operation was aborted.')
}

function withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    message: string
): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(new Error(message))
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new Error(message))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() =>
            signal.removeEventListener('abort', abort)
        )
    })
}

async function waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal
) {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) {
        throwIfAborted(signal)
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    message: string,
    onTimeout?: () => void
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    onTimeout?.()
                    reject(new Error(message))
                }, timeout)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
