import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { CodexSubagentsConfig } from './config.ts'

export interface AgentRole {
    readonly description?: string
    readonly promptAppend?: string
    readonly model?: string
    readonly thinkingLevel?: ThinkingLevel
    /**
     * Legacy additive tool list. These names join the caller's active tools.
     * Restrictions are opt-in through allowTools/denyTools.
     */
    readonly tools?: readonly string[]
    /**
     * Opt-in restriction: when configured, only these names survive the
     * inherited plus `tools` union. It never adds a tool. An empty array
     * allows none. Collaboration tools are governed by denyTools and the
     * native depth/wait rules instead.
     */
    readonly allowTools?: readonly string[]
    /**
     * Opt-in restriction: names that are removed after allowTools and after
     * the `tools` union, so deny always wins.
     */
    readonly denyTools?: readonly string[]
}

export interface ResolvedAgentRole extends AgentRole {
    readonly name: string
}

/** Result of one pure role tool resolution. */
export interface RoleToolResolution {
    /** Final allowlist: inherited plus `tools`, filtered by allow, then deny. */
    readonly tools: readonly string[]
    /** Explicitly denied names; apply to injected collaboration tools too. */
    readonly denied: readonly string[]
    /** True when the role configured allowTools or denyTools. */
    readonly restricted: boolean
}

/**
 * Resolve the tool allowlist for one role without touching session state.
 *
 * Legacy `tools` stays additive, so a role without restrictions keeps the
 * caller's tools. allowTools filters only, denyTools wins, and applying the
 * resolver to its own output is idempotent.
 */
export function resolveRoleTools(
    inherited: readonly string[],
    role: Pick<AgentRole, 'tools' | 'allowTools' | 'denyTools'> | undefined
): RoleToolResolution {
    const union = unique([...inherited, ...(role?.tools ?? [])])
    const allow = role?.allowTools
    const denied = unique(role?.denyTools ?? [])
    const deniedSet = new Set(denied)
    const allowSet = allow === undefined ? undefined : new Set(allow)
    const tools = union.filter(
        (tool) => !deniedSet.has(tool) && (!allowSet || allowSet.has(tool))
    )
    return {
        tools,
        denied,
        restricted: allow !== undefined || role?.denyTools !== undefined,
    }
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

function unique(values: readonly string[]): string[] {
    return [...new Set(values)]
}
