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
    readonly defaultReasoningEffort?: ReasoningEffort
    /** Whether built-in edit/write tools are available; bash is not restricted. */
    readonly canUseWriteTools?: boolean
}

/** Base policy included in every child session. */
export const CHILD_BASE_POLICY = `Complete only the assigned task and stay within its scope. The parent's prompt is authoritative for task-specific objective, context, ownership, constraints, acceptance, and validation.

Read the supplied implementation, follow project conventions, and make the smallest complete change. Start narrow; expand investigation only when needed for correctness, then stop when the task is ready to implement or answer. Keep small work small.

All agents share the filesystem. Preserve concurrent work, stay within assigned scope and ownership, and do not modify unrelated files. Do not spawn agents or ask the user directly.

Use report_to_parent only for a blocking parent decision. Ask one concise question through that tool, state the meaningful alternatives, and finish this run. Keep progress, findings, and non-blocking issues for the final report.

Run focused validation and report only observed commands and results. Finish with the outcome, changed or inspected files, validation, and unresolved risks or blockers. Never claim unsupported success.`

/** Short, role-specific guidance injected into each child session. */
export const AGENT_ROLES: Readonly<Record<AgentRoleName, AgentRole>> = {
    default: {
        name: 'default',
        description: 'General-purpose child agent.',
        instructions: CHILD_BASE_POLICY,
    },
    explorer: {
        name: 'explorer',
        description: 'Codebase investigator.',
        defaultReasoningEffort: 'minimal',
        instructions: `Investigate the assigned question without modifying files. Start from supplied context and trace only relevant definitions, callers, data flow, or configuration. Stop when the answer is supported by repository evidence. Report paths, symbols, evidence, and remaining uncertainty.`,
        canUseWriteTools: false,
    },
    worker: {
        name: 'worker',
        description: 'Implementation-focused child agent.',
        defaultReasoningEffort: 'medium',
        instructions: `Implement the assigned change only. Inspect named files, preserve architecture, and make the smallest complete change. Validate the requested behavior with focused checks, then inspect the diff against the assigned scope. Once the requested behavior is implemented and focused validation is complete, stop.`,
    },
    reviewer: {
        name: 'reviewer',
        description: 'Code reviewer with validation access.',
        defaultReasoningEffort: 'high',
        instructions: `Review the assigned area without edits unless asked. Use shell access only for inspection. Check correctness, security, races, invariants, contracts, regressions, and missing validation. Base findings on code, do not invent issues, and report prioritized findings with validation.`,
        canUseWriteTools: false,
    },
    tester: {
        name: 'tester',
        description: 'Validation agent with shell access.',
        defaultReasoningEffort: 'low',
        instructions: `Validate the assigned behavior without edits unless asked. Start with the smallest focused check, record validation commands and observed results, and classify failures. Do not repair application code; report confirmed or disproved behavior and reproduction details.`,
        canUseWriteTools: false,
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
        model: options.model ?? options.roleModel ?? options.parentModel,
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
