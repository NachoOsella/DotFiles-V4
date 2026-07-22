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
    readonly requiresRootMarker?: boolean
    readonly env?: Readonly<Record<string, string>>
    readonly initialization?: unknown
    readonly disabled?: boolean
}

export interface LspConfig {
    readonly enabled: boolean
    readonly diagnosticsAfterEdit: boolean
    readonly warmOnRead: boolean
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
}

export interface LspLocationResult {
    readonly uri: string
    readonly range: {
        readonly start: Position
        readonly end: Position
    }
}

export type LspResult = Location | Location[] | SymbolInformation[] | unknown
