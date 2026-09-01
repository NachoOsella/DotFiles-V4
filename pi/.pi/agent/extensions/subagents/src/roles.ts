import type { ReasoningEffort } from './domain.ts'

/** Built-in child roles accepted by subagent_spawn. */
export const AGENT_ROLE_NAMES = [
    'default',
    'explorer',
    'worker',
    'reviewer',
    'tester',
] as const

export type AgentRoleName = (typeof AGENT_ROLE_NAMES)[number]

/** Built-in tool allowlists. Extension tools are not implicitly inherited. */
export const READ_ONLY_TOOL_NAMES = [
    'read',
    'grep',
    'find',
    'ls',
    'lsp',
] as const

export const REVIEW_TOOL_NAMES = [...READ_ONLY_TOOL_NAMES, 'bash'] as const

export const CODING_TOOL_NAMES = [
    ...REVIEW_TOOL_NAMES,
    'edit',
    'write',
] as const

export interface AgentRole {
    readonly name: string
    readonly description: string
    readonly instructions: string
    readonly defaultModel?: string
    readonly defaultReasoningEffort?: ReasoningEffort
    /** Read-only is a behavioral contract; bash remains available for checks. */
    readonly readOnly?: boolean
}

/** Base policy included in every child session. */
export const CHILD_BASE_POLICY = `Complete the assigned task and stay strictly within scope.

Inspect existing code before making changes.

All agents share the same filesystem. Do not overwrite, revert, or modify unrelated parallel work.

Do not spawn additional agents or ask the user directly.

Run focused validation when your tools allow it.

Never claim a test, build, or validation passed unless you actually ran it.

When finished, report what you changed or found, relevant files, validation performed, and blockers or unresolved decisions. Keep the final report concise.`

/** Short, role-specific guidance injected into each child session. */
export const AGENT_ROLES: Readonly<Record<AgentRoleName, AgentRole>> = {
    default: {
        name: 'default',
        description: 'General-purpose child agent.',
        instructions: CHILD_BASE_POLICY,
    },
    explorer: {
        name: 'explorer',
        description: 'Cheap read-only codebase investigator.',
        defaultModel: '@cheapest',
        defaultReasoningEffort: 'minimal',
        instructions:
            'Find relevant code, dependencies, patterns, usages, and references. Do not modify files. Cite useful file paths and execution paths in the final report.',
        readOnly: true,
    },
    worker: {
        name: 'worker',
        description: 'Implementation-focused child agent.',
        defaultModel: '@capable',
        defaultReasoningEffort: 'high',
        instructions:
            'Implement one clearly bounded change, make the smallest complete change, run focused validation, and do not modify unrelated code.',
    },
    reviewer: {
        name: 'reviewer',
        description: 'Read-only code reviewer.',
        defaultModel: '@capable',
        defaultReasoningEffort: 'high',
        instructions:
            'Review completed work for material correctness, security, concurrency, maintainability, regressions, and missing tests. Report concrete findings only; do not rewrite the implementation unless explicitly requested.',
        readOnly: true,
    },
    tester: {
        name: 'tester',
        description: 'Read-only validation agent.',
        defaultModel: '@cheapest',
        defaultReasoningEffort: 'low',
        instructions:
            'Run focused tests, builds, linters, reproduction steps, and validation commands. Classify failures clearly and do not modify application source unless explicitly requested.',
        readOnly: true,
    },
}

/** Virtual context-file path reserved for the selected child role. */
export const SUBAGENT_ROLE_CONTEXT_FILE_PATH = '<subagent-role>'

export interface AgentContextFile {
    readonly path: string
    readonly content: string
}

export interface AgentExecutionOptions {
    readonly role: AgentRole
    readonly model?: string
    readonly roleModel?: string
    readonly roleReasoningEffort?: ReasoningEffort
    readonly reasoningEffort?: ReasoningEffort
    readonly parentModel?: string
    readonly parentReasoningEffort?: ReasoningEffort
}

/** Resolves an optional requested role to the default role when omitted. */
export function resolveAgentRole(role?: AgentRoleName): AgentRole {
    return AGENT_ROLES[role ?? 'default']
}

/** Narrows an untrusted role value before it reaches role resolution. */
export function isAgentRoleName(value: unknown): value is AgentRoleName {
    return (
        typeof value === 'string' &&
        (AGENT_ROLE_NAMES as readonly string[]).includes(value)
    )
}

/** Combines the child base policy with a selected role's extra instruction. */
export function childPolicyForRole(role: AgentRole): string {
    return role.name === 'default'
        ? CHILD_BASE_POLICY
        : `${CHILD_BASE_POLICY}\n\nRole: ${role.instructions}`
}

/** Resolves explicit execution settings before role and parent defaults. */
export function resolveAgentExecutionOptions(
    options: AgentExecutionOptions
): Pick<AgentExecutionOptions, 'model' | 'reasoningEffort'> {
    return {
        model:
            options.model ??
            options.roleModel ??
            options.role.defaultModel ??
            options.parentModel,
        reasoningEffort:
            options.reasoningEffort ??
            options.roleReasoningEffort ??
            options.role.defaultReasoningEffort ??
            options.parentReasoningEffort,
    }
}

/** Adds the selected role once to the child resource loader's context files. */
export function withAgentRoleContextFile(
    agentsFiles: ReadonlyArray<AgentContextFile>,
    role: AgentRole
): AgentContextFile[] {
    if (
        agentsFiles.some(
            (file) => file.path === SUBAGENT_ROLE_CONTEXT_FILE_PATH
        )
    ) {
        return agentsFiles as AgentContextFile[]
    }
    return [
        ...agentsFiles,
        {
            path: SUBAGENT_ROLE_CONTEXT_FILE_PATH,
            content: childPolicyForRole(role),
        },
    ]
}
