import { REASONING_EFFORTS, type ReasoningEffort } from './domain.ts'
import type { AgentRoleName } from './roles.ts'

export const DEFAULT_MAX_RUNNING = 8
export const DEFAULT_MAX_TRACKED = 64

/**
 * Sensible per-role defaults for extension tools.
 * Subagents are still filtered by registered + not-builtin, so missing
 * extensions are harmless. Env vars override these defaults.
 */
export const DEFAULT_ALLOWED_EXTENSION_TOOLS: Partial<
    Record<AgentRoleName, ReadonlyArray<string>>
> = {
    // explorer: read-only investigator — fast search + language + web context
    explorer: ['find_files', 'fff_multi_grep', 'lsp', 'codex_search'],
    // worker/default: full implementation — plan, search, run, validate
    worker: [
        'find_files',
        'fff_multi_grep',
        'lsp',
        'todowrite',
        'bg_start',
        'bg_status',
        'bg_list',
        'bg_kill',
        'codex_search',
    ],
    // tester: validation — search, LSP, plan, background runs
    tester: [
        'find_files',
        'fff_multi_grep',
        'lsp',
        'todowrite',
        'bg_start',
        'bg_status',
        'bg_list',
        'bg_kill',
        'codex_search',
    ],
    // reviewer: read + web — no background terminals by default
    reviewer: ['find_files', 'fff_multi_grep', 'lsp', 'todowrite', 'codex_search'],
    default: [
        'find_files',
        'fff_multi_grep',
        'lsp',
        'todowrite',
        'bg_start',
        'bg_status',
        'bg_list',
        'bg_kill',
        'codex_search',
    ],
}

export interface SubagentConfig {
    readonly maxRunning: number
    readonly maxTracked: number
    readonly roleModels: Partial<Record<AgentRoleName, string>>
    readonly roleReasoningEfforts: Partial<
        Record<AgentRoleName, ReasoningEffort>
    >
    /** Explicitly trusted extension tools, never orchestration tools. */
    readonly allowedExtensionTools?: Partial<
        Record<AgentRoleName, ReadonlyArray<string>>
    >
}

function positiveInteger(
    value: string | undefined,
    fallback: number,
    name: string
) {
    if (value === undefined || value.trim() === '') return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive safe integer.`)
    }
    return parsed
}

function model(value: string | undefined) {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function reasoning(value: string | undefined): ReasoningEffort | undefined {
    const trimmed = value?.trim()
    if (!trimmed) return undefined
    if ((REASONING_EFFORTS as readonly string[]).includes(trimmed))
        return trimmed as ReasoningEffort
    throw new Error(
        `Invalid subagent reasoning effort "${trimmed}". Expected one of ${REASONING_EFFORTS.join(', ')}.`
    )
}

function extensionTools(value: string | undefined) {
    const tools = value
        ?.split(',')
        .map((tool) => tool.trim())
        .filter(Boolean)
    return tools && tools.length > 0 ? [...new Set(tools)] : undefined
}

function resolveExtensionTools(
    value: string | undefined,
    isSet: boolean,
    fallback: ReadonlyArray<string> | undefined
) {
    // Not set -> use defaults; explicitly set (even to "" ) -> respect it (undefined = no tools)
    if (!isSet) return fallback
    return extensionTools(value)
}

/**
 * Runtime configuration is intentionally small and environment-based. Model
 * names remain installation-specific, so the extension does not hard-code
 * model identifiers.
 */
export function loadSubagentConfig(
    environment: NodeJS.ProcessEnv = process.env
): SubagentConfig {
    return {
        maxRunning: positiveInteger(
            environment.PI_SUBAGENTS_MAX_RUNNING,
            DEFAULT_MAX_RUNNING,
            'PI_SUBAGENTS_MAX_RUNNING'
        ),
        maxTracked: positiveInteger(
            environment.PI_SUBAGENTS_MAX_TRACKED,
            DEFAULT_MAX_TRACKED,
            'PI_SUBAGENTS_MAX_TRACKED'
        ),
        roleModels: {
            explorer: model(environment.PI_SUBAGENTS_EXPLORER_MODEL),
            tester: model(environment.PI_SUBAGENTS_TESTER_MODEL),
            worker: model(environment.PI_SUBAGENTS_WORKER_MODEL),
            reviewer: model(environment.PI_SUBAGENTS_REVIEWER_MODEL),
            default: model(environment.PI_SUBAGENTS_DEFAULT_MODEL),
        },
        roleReasoningEfforts: {
            explorer: reasoning(environment.PI_SUBAGENTS_EXPLORER_REASONING),
            tester: reasoning(environment.PI_SUBAGENTS_TESTER_REASONING),
            worker: reasoning(environment.PI_SUBAGENTS_WORKER_REASONING),
            reviewer: reasoning(environment.PI_SUBAGENTS_REVIEWER_REASONING),
            default: reasoning(environment.PI_SUBAGENTS_DEFAULT_REASONING),
        },
        allowedExtensionTools: {
            explorer: resolveExtensionTools(
                environment.PI_SUBAGENTS_EXPLORER_EXTENSION_TOOLS,
                'PI_SUBAGENTS_EXPLORER_EXTENSION_TOOLS' in environment,
                DEFAULT_ALLOWED_EXTENSION_TOOLS.explorer
            ),
            tester: resolveExtensionTools(
                environment.PI_SUBAGENTS_TESTER_EXTENSION_TOOLS,
                'PI_SUBAGENTS_TESTER_EXTENSION_TOOLS' in environment,
                DEFAULT_ALLOWED_EXTENSION_TOOLS.tester
            ),
            worker: resolveExtensionTools(
                environment.PI_SUBAGENTS_WORKER_EXTENSION_TOOLS,
                'PI_SUBAGENTS_WORKER_EXTENSION_TOOLS' in environment,
                DEFAULT_ALLOWED_EXTENSION_TOOLS.worker
            ),
            reviewer: resolveExtensionTools(
                environment.PI_SUBAGENTS_REVIEWER_EXTENSION_TOOLS,
                'PI_SUBAGENTS_REVIEWER_EXTENSION_TOOLS' in environment,
                DEFAULT_ALLOWED_EXTENSION_TOOLS.reviewer
            ),
            default: resolveExtensionTools(
                environment.PI_SUBAGENTS_DEFAULT_EXTENSION_TOOLS,
                'PI_SUBAGENTS_DEFAULT_EXTENSION_TOOLS' in environment,
                DEFAULT_ALLOWED_EXTENSION_TOOLS.default
            ),
        },
    }
}
