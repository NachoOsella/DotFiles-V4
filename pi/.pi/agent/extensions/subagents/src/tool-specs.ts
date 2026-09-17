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
import {
    DEFAULT_SUBAGENTS_CONFIG,
    type CodexSubagentsConfig,
} from './config.ts'

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
            minLength: 1,
            pattern: '\\S',
            description:
                'One nonempty, bounded delegated task for the new agent.',
        }),
        task_name: Type.String({
            minLength: 1,
            pattern: '^[a-z0-9_]+$',
            description:
                'One nonempty path segment: lowercase letters, digits, and underscores only.',
        }),
        fork_turns: Type.Optional(
            Type.Union([
                Type.Literal('all'),
                Type.Literal('none'),
                Type.String({
                    pattern: '^[1-9][0-9]*$',
                    description:
                        'A positive integer N for the most recent N turns.',
                }),
            ])
        ),
    }
    if (!config.hideSpawnAgentMetadata) {
        const customNames = Object.keys(config.roles)
            .filter((name) => name !== 'default')
            .sort()
        const names = customNames.length > 0 ? ['default', ...customNames] : []
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
            Type.String({
                minLength: 3,
                pattern: '^[^/\\s]+/[^/\\s]+$',
                description: 'Child model in provider/model-id form.',
            })
        )
        properties.reasoning_effort = Type.Optional(
            Type.Union(
                [
                    Type.Literal('off'),
                    Type.Literal('minimal'),
                    Type.Literal('low'),
                    Type.Literal('medium'),
                    Type.Literal('high'),
                    Type.Literal('xhigh'),
                    Type.Literal('max'),
                ],
                {
                    description:
                        'Child reasoning effort: off, minimal, low, medium, high, xhigh, or max.',
                }
            )
        )
    }
    return Type.Object(properties as never, { additionalProperties: false })
}

function createSpawnAgentParams(config: SpawnSchemaConfig) {
    return buildSpawnAgentParams(config)
}

const targetSchema = () =>
    Type.String({
        minLength: 1,
        pattern:
            '^(?:/root(?:/[a-z0-9_]+)*|(?:\\./|\\.\\./)?[a-z0-9_]+(?:/[a-z0-9_]+)*)$',
        description:
            'Valid agent target. Prefer the canonical /root/... path returned by spawn_agent or list_agents because relative names resolve from the caller.',
    })

const messageSchema = (description: string) =>
    Type.String({ minLength: 1, pattern: '\\S', description })

export const SendMessageParams = Type.Object(
    {
        target: targetSchema(),
        message: messageSchema(
            'Nonempty context payload; send_message queues it without starting a turn.'
        ),
    },
    { additionalProperties: false }
)

export const FollowupTaskParams = Type.Object(
    {
        target: targetSchema(),
        message: messageSchema(
            'Nonempty task payload; followup_task queues NEW_TASK, steering an active run or starting one when idle.'
        ),
    },
    { additionalProperties: false }
)

export interface WaitSchemaConfig {
    readonly wait: CodexSubagentsConfig['wait']
}

/** Build the wait schema using the resolved V3 timeout bounds. */
export function buildWaitAgentParams(config: WaitSchemaConfig) {
    return Type.Object(
        {
            timeout_ms: Type.Optional(
                Type.Integer({
                    minimum: config.wait.minTimeoutMs,
                    maximum: config.wait.maxTimeoutMs,
                    description: `Optional integer timeout in milliseconds (${config.wait.minTimeoutMs}-${config.wait.maxTimeoutMs}); defaults to ${config.wait.defaultTimeoutMs}.`,
                })
            ),
        },
        { additionalProperties: false }
    )
}

export const WaitAgentParams = buildWaitAgentParams(DEFAULT_SUBAGENTS_CONFIG)

export const InterruptAgentParams = Type.Object(
    {
        target: targetSchema(),
    },
    { additionalProperties: false }
)

export const ListAgentsParams = Type.Object(
    {
        path_prefix: Type.Optional(
            Type.String({
                minLength: 5,
                pattern: '^/root(?:/[a-z0-9_]+)*$',
                description: 'Canonical /root/... subtree prefix.',
            })
        ),
    },
    { additionalProperties: false }
)

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
