import { REASONING_EFFORTS, type ReasoningEffort } from './domain.ts'
import type { AgentRoleName } from './roles.ts'

export const DEFAULT_MAX_RUNNING = 8
export const DEFAULT_MAX_TRACKED = 64

export interface SubagentConfig {
    readonly maxRunning: number
    readonly maxTracked: number
    readonly roleModels: Partial<Record<AgentRoleName, string>>
    readonly roleReasoningEfforts: Partial<
        Record<AgentRoleName, ReasoningEffort>
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

/**
 * Runtime configuration is intentionally small and environment-based. Model
 * names remain installation-specific, so there are no unsafe hard-coded cheap
 * model identifiers in the extension.
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
    }
}
