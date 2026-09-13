import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { CodexSubagentsConfig } from './config.ts'

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

export function resolveRole(
    config: CodexSubagentsConfig,
    requested: string | undefined
): ResolvedAgentRole {
    const name = requested?.trim() || 'default'
    const configured = config.roles[name]
    if (name !== 'default' && !configured) {
        throw new Error(`Unknown agent_type "${name}".`)
    }
    return { name, ...(configured ?? {}) }
}

export function roleNames(config: CodexSubagentsConfig): string[] {
    return Object.keys(config.roles).sort()
}
