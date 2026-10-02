/**
 * Model-visible tool schemas.
 *
 * These preserve the legacy input contracts that the native migration must
 * keep: closed objects, nonempty/pattern-constrained strings, configured wait
 * bounds, and conditional exposure of model overrides and role names.
 */

import { Type } from '@earendil-works/pi-ai'
import type { SubagentsConfig } from '../config/config.js'
import type { ThinkingLevel } from '../config/roles.js'

/** Canonical agent target accepted by target-taking tools. */
export function targetSchema() {
    return Type.String({
        minLength: 1,
        pattern:
            '^(?:/root(?:/[a-z0-9_]+)*|(?:\\./|\\.\\./)?[a-z0-9_]+(?:/[a-z0-9_]+)*)$',
        description:
            'Valid agent target. Prefer the canonical /root/... path returned by spawn_agent or list_agents because relative names resolve from the caller.',
    })
}

function messageSchema(description: string) {
    return Type.String({ minLength: 1, pattern: '\\S', description })
}

/** Spawn schema, including only the fields the configuration exposes. */
export function buildSpawnAgentParams(config: SubagentsConfig) {
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
        if (names.length === 1) {
            properties.agent_type = Type.Optional(Type.Literal(names[0]!))
        } else if (names.length > 1) {
            properties.agent_type = Type.Optional(
                Type.Union(names.map((name) => Type.Literal(name)))
            )
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
                THINKING_LITERALS.map((level) => Type.Literal(level)),
                {
                    description:
                        'Child reasoning effort: off, minimal, low, medium, high, xhigh, or max.',
                }
            )
        )
    }
    return Type.Object(properties as never, { additionalProperties: false })
}

const THINKING_LITERALS: readonly ThinkingLevel[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]

export function buildWaitAgentParams(config: SubagentsConfig) {
    return Type.Object(
        {
            timeout_ms: Type.Optional(
                Type.Integer({
                    minimum: config.wait.minTimeoutMs,
                    maximum: config.wait.maxTimeoutMs,
                    description: `Optional integer timeout in milliseconds (${config.wait.minTimeoutMs}-${config.wait.maxTimeoutMs}); defaults to ${config.wait.defaultTimeoutMs}.`,
                })
            ),
            targets: Type.Optional(
                Type.Array(targetSchema(), {
                    description:
                        'Optional targets whose current work to await. The wait still never consumes their answers.',
                })
            ),
        },
        { additionalProperties: false }
    )
}

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
        mode: Type.Optional(
            Type.Union([Type.Literal('steer'), Type.Literal('followUp')], {
                description:
                    'Durable queue mode. Defaults to steer, which joins running work; followUp waits for the current answer.',
            })
        ),
    },
    { additionalProperties: false }
)

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
