import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import type {
    Diagnostic,
    DocumentSymbol,
    Location,
    SymbolInformation,
} from 'vscode-languageserver-types'
import { languageIdForPath } from './language.ts'
import type { ServerConfig } from '../types.ts'

const INITIALIZE_TIMEOUT_MS = 45_000
const REQUEST_TIMEOUT_MS = 8_000
const DIAGNOSTIC_TIMEOUT_MS = 5_000

const FULL_SYNC = 1
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
    readonly touchFile: (
        filePath: string,
        waitForDiagnostics: boolean
    ) => Promise<void>
    readonly diagnostics: () => ReadonlyMap<string, readonly Diagnostic[]>
    readonly request: (request: ClientRequest) => Promise<unknown>
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
}

interface ServerCapabilities {
    readonly textDocumentSync?: number | { readonly change?: number }
    readonly diagnosticProvider?: unknown
}

export async function startClient(input: {
    serverId: string
    config: ServerConfig
    root: string
}): Promise<LspClient> {
    const [command, ...args] = input.config.command
    if (!command)
        throw new Error(`LSP server ${input.serverId} has an empty command.`)

    const child = spawn(command, args, {
        cwd: input.root,
        env: { ...process.env, ...input.config.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.stderr.on('data', () => undefined)
    const connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
    )

    let state: ClientStatus = { state: 'connected', openDocuments: 0 }
    const documents = new Map<string, OpenDocument>()
    const pushedDiagnostics = new Map<string, Diagnostic[]>()
    const diagnosticPublishedAt = new Map<string, number>()
    let initializedCapabilities: ServerCapabilities = {}
    let shutdown = false

    connection.onNotification(
        'textDocument/publishDiagnostics',
        (params: { uri: string; diagnostics?: Diagnostic[] }) => {
            const filePath = filePathFromUri(params.uri)
            pushedDiagnostics.set(filePath, params.diagnostics ?? [])
            diagnosticPublishedAt.set(filePath, Date.now())
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
        const initialized = await withTimeout(
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
                        workspace: { configuration: true },
                        textDocument: {
                            synchronization: {
                                dynamicRegistration: false,
                                didOpen: true,
                                didChange: true,
                            },
                            publishDiagnostics: { versionSupport: false },
                            diagnostic: {
                                dynamicRegistration: true,
                                relatedDocumentSupport: true,
                            },
                        },
                        window: { workDoneProgress: true },
                    },
                }
            ),
            INITIALIZE_TIMEOUT_MS,
            'LSP initialize timed out'
        )
        initializedCapabilities = initialized.capabilities ?? {}
        await connection.sendNotification('initialized', {})
        if (input.config.initialization !== undefined) {
            await connection.sendNotification(
                'workspace/didChangeConfiguration',
                {
                    settings: input.config.initialization,
                }
            )
        }
    } catch (error) {
        connection.dispose()
        terminateProcess(child)
        throw error
    }

    const syncKind = getSyncKind(initializedCapabilities.textDocumentSync)
    child.once('exit', (_code, signal) => {
        if (!shutdown) {
            state = {
                ...state,
                state: 'broken',
                lastError: `LSP process exited${signal ? ` with ${signal}` : ''}.`,
            }
        }
    })

    return {
        serverId: input.serverId,
        root: input.root,
        extensions: input.config.extensions,
        status: () => ({ ...state, openDocuments: documents.size }),
        touchFile: async (filePath, waitForDiagnostics) => {
            const text = await readFile(filePath, 'utf8')
            const uri = pathToFileURL(filePath).href
            const current = documents.get(filePath)
            const after = Date.now()

            if (!current) {
                await connection.sendNotification('textDocument/didOpen', {
                    textDocument: {
                        uri,
                        languageId: languageIdForPath(filePath),
                        version: 0,
                        text,
                    },
                })
                documents.set(filePath, { version: 0, text })
            } else {
                const version = current.version + 1
                await connection.sendNotification('textDocument/didChange', {
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
                documents.set(filePath, { version, text })
            }

            await connection.sendNotification(
                'workspace/didChangeWatchedFiles',
                {
                    changes: [{ uri, type: current ? 2 : 1 }],
                }
            )

            if (waitForDiagnostics)
                await waitForDiagnosticsResult(filePath, uri, after)
        },
        diagnostics: () =>
            new Map(
                [...pushedDiagnostics.entries()].map(([filePath, values]) => [
                    filePath,
                    [...values],
                ])
            ),
        request: async ({ method, params }) => {
            if (
                method === 'textDocument/diagnostic' &&
                initializedCapabilities.diagnosticProvider
            ) {
                const result = await withTimeout(
                    connection.sendRequest<{ items?: Diagnostic[] } | null>(
                        method,
                        params
                    ),
                    REQUEST_TIMEOUT_MS,
                    `${method} timed out`
                )
                const filePath = filePathFromUri(
                    (params as { textDocument: { uri: string } }).textDocument
                        .uri
                )
                pushedDiagnostics.set(filePath, result?.items ?? [])
                diagnosticPublishedAt.set(filePath, Date.now())
                return result
            }
            return withTimeout(
                connection.sendRequest(method, params),
                REQUEST_TIMEOUT_MS,
                `${method} timed out`
            )
        },
        shutdown: async () => {
            if (shutdown) return
            shutdown = true
            try {
                await withTimeout(
                    connection.sendRequest('shutdown', null),
                    2_000,
                    'LSP shutdown timed out'
                )
            } catch {
                // The process may already have exited; cleanup below is still required.
            }
            try {
                await connection.sendNotification('exit')
            } catch {
                // Ignore protocol errors while shutting down.
            }
            connection.dispose()
            terminateProcess(child)
            documents.clear()
            pushedDiagnostics.clear()
            diagnosticPublishedAt.clear()
        },
    }

    async function waitForDiagnosticsResult(
        filePath: string,
        uri: string,
        after: number
    ) {
        if (initializedCapabilities.diagnosticProvider) {
            try {
                await withTimeout<unknown>(
                    connection.sendRequest('textDocument/diagnostic', {
                        textDocument: { uri },
                    }),
                    DIAGNOSTIC_TIMEOUT_MS,
                    'LSP diagnostics timed out'
                ).then((result) => {
                    pushedDiagnostics.set(
                        filePath,
                        (result as { items?: Diagnostic[] } | null)?.items ?? []
                    )
                    diagnosticPublishedAt.set(filePath, Date.now())
                })
            } catch {
                // Push diagnostics remain useful when pull diagnostics are unavailable.
            }
            return
        }

        await new Promise<void>((resolve) => {
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                clearInterval(interval)
                resolve()
            }
            const timer = setTimeout(finish, DIAGNOSTIC_TIMEOUT_MS)
            const interval = setInterval(() => {
                if ((diagnosticPublishedAt.get(filePath) ?? 0) >= after)
                    finish()
            }, 100)
            if ((diagnosticPublishedAt.get(filePath) ?? 0) >= after) finish()
        })
    }
}

function getSyncKind(value: ServerCapabilities['textDocumentSync']): number {
    if (typeof value === 'number') return value
    return value?.change ?? FULL_SYNC
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

function terminateProcess(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
    }, 5_000).unref()
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    message: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeout)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
