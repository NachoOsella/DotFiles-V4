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
    readonly code = 'agent_capacity_reached'
    readonly limit: number
    readonly active: number
    readonly guidance =
        'Wait for a running agent to finish or reuse an existing agent with followup_task instead of spawning another identity.'
    constructor(limit: number, active: number) {
        super(
            `[${'agent_capacity_reached'}] Agent spawn rejected: ${active}/${limit} active slots in use. ${'Wait for a running agent to finish or reuse an existing agent with followup_task instead of spawning another identity.'}`
        )
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

/** Shared tree budget cannot admit more work. */
export class TokenBudgetExhaustedError extends Error {
    readonly _tag = 'TokenBudgetExhausted'
    readonly code = 'budget_exhausted_tokens'
    readonly consumed: number
    readonly limit: number
    readonly guidance =
        'Raise limits.maxTreeTokens, start a new root session, or finish remaining work without new child runs.'
    constructor(consumed: number, limit: number) {
        super(
            `[budget_exhausted_tokens] Tree token budget exhausted: ${consumed}/${limit}. Raise limits.maxTreeTokens, start a new root session, or finish remaining work without new child runs.`
        )
        this.name = 'TokenBudgetExhaustedError'
        this.consumed = consumed
        this.limit = limit
    }
}

/** One run exceeded its wall-clock deadline. */
export class RunDeadlineExceededError extends Error {
    readonly _tag = 'RunDeadlineExceeded'
    readonly code = 'deadline_exceeded'
    readonly limitMs: number
    readonly guidance =
        'Split the task into smaller bounded work, or raise limits.runDeadlineMs for this project.'
    constructor(limitMs: number) {
        super(
            `[deadline_exceeded] Run deadline exceeded after ${limitMs}ms. Split the task into smaller bounded work, or raise limits.runDeadlineMs for this project.`
        )
        this.name = 'RunDeadlineExceededError'
        this.limitMs = limitMs
    }
}

/** One run exceeded its model-request allowance. */
export class ModelRequestLimitError extends Error {
    readonly _tag = 'ModelRequestLimitExceeded'
    readonly code = 'request_limit_exceeded'
    readonly limit: number
    readonly requests: number
    readonly guidance =
        'Narrow the task or raise limits.maxModelRequestsPerRun. Use followup_task to continue with a fresh allowance.'
    constructor(limit: number, requests: number) {
        super(
            `[request_limit_exceeded] Model request limit reached: ${requests}/${limit}. Narrow the task or raise limits.maxModelRequestsPerRun. Use followup_task to continue with a fresh allowance.`
        )
        this.name = 'ModelRequestLimitError'
        this.limit = limit
        this.requests = requests
    }
}

/** A saved agent cannot be reopened under current state or policy. */
export class AgentBlockedError extends Error {
    readonly _tag = 'AgentBlocked'
    readonly code = 'agent_blocked'
    readonly path: string
    readonly reason: string
    readonly guidance: string
    constructor(path: string, reason: string, guidance: string) {
        super(
            `[agent_blocked] Agent "${path}" is blocked: ${reason} ${guidance}`
        )
        this.name = 'AgentBlockedError'
        this.path = path
        this.reason = reason
        this.guidance = guidance
    }
}
