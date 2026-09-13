/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/core/src/tools/handlers/multi_agents_spec.rs
 * codex-rs/core/src/tools/spec_plan.rs
 *
 * Exact six-tool V2 family. Forbidden V1 names are never registered:
 * send_input, resume_agent, close_agent, assign_task.
 */

import { Type } from 'typebox'
import type { CodexSubagentsConfig } from './config.ts'

export const COLLABORATION_NAMESPACE = 'collaboration'

export const TOOL_SPAWN_AGENT = 'spawn_agent'
export const TOOL_SEND_MESSAGE = 'send_message'
export const TOOL_FOLLOWUP_TASK = 'followup_task'
export const TOOL_WAIT_AGENT = 'wait_agent'
export const TOOL_INTERRUPT_AGENT = 'interrupt_agent'
export const TOOL_LIST_AGENTS = 'list_agents'

type SpawnSchemaConfig = Pick<
    CodexSubagentsConfig,
    'exposeSpawnAgentModelOverrides' | 'hideSpawnAgentMetadata' | 'roles'
>

export const SpawnAgentParams = createSpawnAgentParams({
    exposeSpawnAgentModelOverrides: true,
    hideSpawnAgentMetadata: false,
    roles: {},
})

/** Build the model-visible spawn schema from the resolved extension config. */
export function buildSpawnAgentParams(config: SpawnSchemaConfig) {
    const properties: Record<string, unknown> = {
        message: Type.String({
            description: 'One bounded delegated task for the new agent.',
        }),
        task_name: Type.String({
            description:
                'Single path segment (lowercase letters, digits, underscore).',
        }),
        fork_turns: Type.Optional(
            Type.String({
                description: 'History to fork: "all" (default), "none", or N.',
            })
        ),
    }
    if (!config.hideSpawnAgentMetadata) {
        const names = Object.keys(config.roles).filter(
            (name) => name !== 'default'
        )
        if (names.length > 0) {
            const agentType =
                names.length === 1
                    ? Type.Literal(names[0]!)
                    : Type.Union(names.map((name) => Type.Literal(name)))
            properties.agent_type = Type.Optional(agentType)
        }
    }
    if (config.exposeSpawnAgentModelOverrides) {
        properties.model = Type.Optional(
            Type.String({ description: 'Child model as provider/model-id.' })
        )
        properties.reasoning_effort = Type.Optional(
            Type.String({
                description:
                    'Child reasoning: off, minimal, low, medium, high, xhigh, or max.',
            })
        )
    }
    return Type.Object(properties as never)
}

function createSpawnAgentParams(config: SpawnSchemaConfig) {
    return buildSpawnAgentParams(config)
}

export const SendMessageParams = Type.Object({
    target: Type.String({
        description: 'Canonical /root/... path or relative task name.',
    }),
    message: Type.String({ description: 'Queue-only message payload.' }),
})

export const FollowupTaskParams = Type.Object({
    target: Type.String({
        description: 'Canonical /root/... path or relative task name.',
    }),
    message: Type.String({ description: 'Follow-up task payload.' }),
})

export const WaitAgentParams = Type.Object({
    timeout_ms: Type.Optional(
        Type.Number({ description: 'Wait timeout in milliseconds.' })
    ),
})

export const InterruptAgentParams = Type.Object({
    target: Type.String({
        description: 'Canonical /root/... path or relative task name.',
    }),
})

export const ListAgentsParams = Type.Object({
    path_prefix: Type.Optional(
        Type.String({ description: 'Scope listing to one subtree.' })
    ),
})

export const FORBIDDEN_V1_TOOLS = [
    'send_input',
    'resume_agent',
    'close_agent',
    'assign_task',
] as const

export interface ToolPlanInput {
    readonly waitAgentEnabled: boolean
}

/** Exact V2 tool family for the current config. */
export function plannedV2Tools(input: ToolPlanInput): string[] {
    const tools = [TOOL_SPAWN_AGENT, TOOL_SEND_MESSAGE, TOOL_FOLLOWUP_TASK]
    if (input.waitAgentEnabled) tools.push(TOOL_WAIT_AGENT)
    tools.push(TOOL_INTERRUPT_AGENT, TOOL_LIST_AGENTS)
    return tools
}

/** Guard against V1 leakage at registration time. */
export function assertNoForbiddenTools(names: readonly string[]): void {
    for (const name of names) {
        if ((FORBIDDEN_V1_TOOLS as readonly string[]).includes(name)) {
            throw new Error(`Forbidden V1 tool registered: ${name}`)
        }
    }
}
