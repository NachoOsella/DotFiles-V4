/** Reasoning levels, ordered from least to most effort. */
export type ThinkingLevel =
    'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return (
        typeof value === 'string' &&
        (THINKING_LEVELS as readonly string[]).includes(value)
    )
}

export interface AgentRole {
    readonly description?: string
    readonly promptAppend?: string
    readonly model?: string
    readonly thinkingLevel?: ThinkingLevel
    readonly tools?: readonly string[]
}

export interface ResolvedAgentRole extends AgentRole {
    readonly name: string
}

/**
 * Resolve a requested role name. An omitted or blank request selects
 * `default`; an unknown non-default name is an error. Own-property lookup
 * keeps prototype names such as `constructor` unconfigured.
 */
export function resolveRole(
    config: { readonly roles: Record<string, AgentRole> },
    requested?: string
): ResolvedAgentRole {
    const name = requested?.trim() || 'default'
    const configured = Object.hasOwn(config.roles, name)
        ? config.roles[name]
        : undefined
    if (name !== 'default' && !configured) {
        throw new UnknownAgentTypeError(name)
    }
    return { name, ...(configured ?? {}) }
}

export class UnknownAgentTypeError extends Error {
    readonly _tag = 'UnknownAgentType'
    readonly agentType: string

    constructor(agentType: string) {
        super(`Unknown agent_type "${agentType}".`)
        this.name = 'UnknownAgentTypeError'
        this.agentType = agentType
    }
}
