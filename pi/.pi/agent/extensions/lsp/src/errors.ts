import { Data } from 'effect'

export class LspDisabled extends Data.TaggedError('LspDisabled')<{
    readonly message: string
}> {}

export class LspServerUnavailable extends Data.TaggedError(
    'LspServerUnavailable'
)<{
    readonly message: string
    readonly serverId: string
    readonly filePath: string
}> {}

export class LspInitializationError extends Data.TaggedError(
    'LspInitializationError'
)<{
    readonly message: string
    readonly serverId: string
    readonly cause: unknown
}> {}

export class LspRequestError extends Data.TaggedError('LspRequestError')<{
    readonly message: string
    readonly method: string
    readonly cause: unknown
}> {}

export type LspError =
    | LspDisabled
    | LspServerUnavailable
    | LspInitializationError
    | LspRequestError
