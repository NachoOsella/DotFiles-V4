import type {
    Diagnostic,
    Location,
    Position,
    SymbolInformation,
} from 'vscode-languageserver-types'

export type DiagnosticMode = 'document' | 'full'

export interface ServerConfig {
    readonly command: readonly string[]
    readonly extensions: readonly string[]
    readonly rootMarkers: readonly string[]
    /** Higher values win when multiple servers support the same file. */
    readonly priority?: number
    readonly requiresRootMarker?: boolean
    readonly env?: Readonly<Record<string, string>>
    readonly initialization?: unknown
    readonly disabled?: boolean
}

export interface LspConfig {
    readonly enabled: boolean
    readonly diagnosticsAfterEdit: boolean
    readonly warmOnRead: boolean
    /** Shut down clients after this much inactivity to avoid orphaned servers. */
    readonly idleTimeoutMs: number
    readonly servers: Readonly<Record<string, ServerConfig>>
}

export interface LspDiagnostic extends Diagnostic {
    readonly filePath: string
    readonly serverId: string
}

export interface LspStatus {
    readonly id: string
    readonly root: string
    readonly state: 'starting' | 'connected' | 'broken'
    readonly extensions: readonly string[]
    readonly openDocuments: number
    readonly lastError?: string
}

export type LspOperation =
    | 'definition'
    | 'references'
    | 'hover'
    | 'documentSymbols'
    | 'workspaceSymbols'
    | 'implementation'

export interface LspRequest {
    readonly operation: LspOperation
    readonly filePath: string
    readonly line?: number
    readonly character?: number
    readonly query?: string
    readonly limit?: number
    readonly offset?: number
    readonly contextLines?: number
}

export interface LspLocationResult {
    readonly uri: string
    readonly range: {
        readonly start: Position
        readonly end: Position
    }
}

export type LspResult = Location | Location[] | SymbolInformation[] | unknown
