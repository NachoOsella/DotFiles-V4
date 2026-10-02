/** Typed subagent errors as tagged Error subclasses. */

export class AgentNotFoundError extends Error {
    readonly _tag = 'AgentNotFound'
    readonly path: string
    constructor(path: string) {
        super(`Agent not found: "${path}".`)
        this.name = 'AgentNotFoundError'
        this.path = path
    }
}

export class AgentAlreadyExistsError extends Error {
    readonly _tag = 'AgentAlreadyExists'
    readonly path: string
    constructor(path: string) {
        super(`Agent already exists: "${path}".`)
        this.name = 'AgentAlreadyExistsError'
        this.path = path
    }
}

export class AgentCapacityReachedError extends Error {
    readonly _tag = 'AgentCapacityReached'
    readonly limit: number
    readonly active: number
    constructor(limit: number, active: number) {
        super(`Agent spawn rejected: ${active}/${limit} active slots in use.`)
        this.name = 'AgentCapacityReachedError'
        this.limit = limit
        this.active = active
    }
}

export class InvalidModelOverrideError extends Error {
    readonly _tag = 'InvalidModelOverride'
    readonly reason: string
    constructor(reason: string) {
        super(`Invalid model override: ${reason}`)
        this.name = 'InvalidModelOverrideError'
        this.reason = reason
    }
}

export class RootFollowupForbiddenError extends Error {
    readonly _tag = 'RootFollowupForbidden'
    constructor() {
        super('followup_task cannot target /root.')
        this.name = 'RootFollowupForbiddenError'
    }
}

export class SelfInterruptForbiddenError extends Error {
    readonly _tag = 'SelfInterruptForbidden'
    constructor() {
        super('An agent cannot interrupt itself; ask the parent or a peer.')
        this.name = 'SelfInterruptForbiddenError'
    }
}

export class AgentLoadFailedError extends Error {
    readonly _tag = 'AgentLoadFailed'
    readonly path: string
    readonly causeMessage: string
    constructor(path: string, causeMessage: string) {
        super(`Failed to load agent "${path}": ${causeMessage}`)
        this.name = 'AgentLoadFailedError'
        this.path = path
        this.causeMessage = causeMessage
    }
}

export class AgentSpawnFailedError extends Error {
    readonly _tag = 'AgentSpawnFailed'
    readonly reason: string
    constructor(reason: string) {
        super(`Failed to spawn agent: ${reason}`)
        this.name = 'AgentSpawnFailedError'
        this.reason = reason
    }
}

export class MailboxClosedError extends Error {
    readonly _tag = 'MailboxClosed'
    constructor() {
        super('Agent mailbox is closed.')
        this.name = 'MailboxClosedError'
    }
}

export class PiHostError extends Error {
    readonly _tag = 'PiHostError'
    readonly reason: string
    constructor(reason: string) {
        super(`Pi host failure: ${reason}`)
        this.name = 'PiHostError'
        this.reason = reason
    }
}
