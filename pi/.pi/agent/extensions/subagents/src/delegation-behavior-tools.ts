import * as fs from 'node:fs'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { REASONING_EFFORTS } from './domain.ts'
import { AGENT_ROLE_NAMES } from './roles.ts'
import {
    SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
    SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
    SUBAGENT_CHECK_TOOL_DESCRIPTION,
    SUBAGENT_CLOSE_PARAMETER_DESCRIPTIONS,
    SUBAGENT_CLOSE_TOOL_DESCRIPTION,
    SUBAGENT_INTERRUPT_PARAMETER_DESCRIPTIONS,
    SUBAGENT_INTERRUPT_TOOL_DESCRIPTION,
    SUBAGENT_LIST_TOOL_DESCRIPTION,
    SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
    SUBAGENT_SEND_TOOL_DESCRIPTION,
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
    SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    SUBAGENT_SPAWN_PROMPT_SNIPPET,
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from './prompt.ts'

const LOG_PATH_ENV = 'PI_SUBAGENTS_BEHAVIOR_LOG'

function recordCall(name: string, args: unknown) {
    const logPath = process.env[LOG_PATH_ENV]
    if (!logPath) return
    fs.appendFileSync(
        logPath,
        `${JSON.stringify({ name, args, at: Date.now() })}\n`,
        'utf8'
    )
}

function result(name: string) {
    return {
        content: [
            {
                type: 'text' as const,
                text: `${name} was intercepted by the behavioral delegation eval; no child work was launched.`,
            },
        ],
        details: { intercepted: true, tool: name },
    }
}

/**
 * Registers the real parent-facing collaboration surface with harmless
 * interceptors. The behavioral eval loads this file explicitly and records
 * actual model tool calls instead of asking the model to describe them.
 */
export default function registerBehaviorTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: 'subagent_spawn',
        label: 'Spawn Subagent',
        description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
        promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
        promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
        parameters: Type.Object({
            prompt: Type.String({
                description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
            }),
            name: Type.String({
                description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
            }),
            task_name: Type.Optional(
                Type.String({
                    description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.taskName,
                })
            ),
            agent_type: Type.Optional(
                StringEnum(AGENT_ROLE_NAMES, {
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.agentType,
                })
            ),
            working_dir: Type.Optional(
                Type.String({
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
                })
            ),
            model: Type.Optional(
                Type.String({
                    description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
                })
            ),
            reasoning_effort: Type.Optional(
                StringEnum(REASONING_EFFORTS, {
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
                })
            ),
            owned_paths: Type.Optional(
                Type.Array(Type.String(), {
                    maxItems: 64,
                    description:
                        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.ownedPaths,
                })
            ),
        }),
        async execute(_toolCallId, params) {
            recordCall('subagent_spawn', params)
            return result('subagent_spawn')
        },
    })

    pi.registerTool({
        name: 'subagent_send',
        label: 'Send to Subagent',
        description: SUBAGENT_SEND_TOOL_DESCRIPTION,
        parameters: Type.Object({
            id: Type.String({
                description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
            }),
            message: Type.String({
                description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
            }),
            delivery: Type.Optional(
                StringEnum(['steer', 'follow-up'] as const, {
                    description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.delivery,
                })
            ),
        }),
        async execute(_toolCallId, params) {
            recordCall('subagent_send', params)
            return result('subagent_send')
        },
    })

    pi.registerTool({
        name: 'subagent_wait',
        label: 'Wait for Subagents',
        description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
        parameters: Type.Object({
            ids: Type.Optional(
                Type.Array(Type.String(), {
                    maxItems: 64,
                    description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
                })
            ),
            after_sequence: Type.Optional(
                Type.Integer({
                    minimum: 0,
                    description:
                        SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.afterSequence,
                })
            ),
        }),
        async execute(_toolCallId, params) {
            recordCall('subagent_wait', params)
            return result('subagent_wait')
        },
    })

    const registerIdsTool = (
        name: 'subagent_cancel' | 'subagent_interrupt' | 'subagent_close',
        label: string,
        description: string,
        parameterDescription: string
    ) =>
        pi.registerTool({
            name,
            label,
            description,
            parameters: Type.Object({
                ids: Type.Array(Type.String(), {
                    description: parameterDescription,
                }),
            }),
            async execute(_toolCallId, params) {
                recordCall(name, params)
                return result(name)
            },
        })

    registerIdsTool(
        'subagent_cancel',
        'Cancel Subagents',
        SUBAGENT_CANCEL_TOOL_DESCRIPTION,
        SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids
    )
    registerIdsTool(
        'subagent_interrupt',
        'Interrupt Subagents',
        SUBAGENT_INTERRUPT_TOOL_DESCRIPTION,
        SUBAGENT_INTERRUPT_PARAMETER_DESCRIPTIONS.ids
    )
    registerIdsTool(
        'subagent_close',
        'Close Subagents',
        SUBAGENT_CLOSE_TOOL_DESCRIPTION,
        SUBAGENT_CLOSE_PARAMETER_DESCRIPTIONS.ids
    )

    pi.registerTool({
        name: 'subagent_check',
        label: 'Check Subagent',
        description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
        parameters: Type.Object({
            id: Type.String({
                description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
            }),
        }),
        async execute(_toolCallId, params) {
            recordCall('subagent_check', params)
            return result('subagent_check')
        },
    })

    pi.registerTool({
        name: 'subagent_list',
        label: 'List Subagents',
        description: SUBAGENT_LIST_TOOL_DESCRIPTION,
        parameters: Type.Object({}),
        async execute(_toolCallId, params) {
            recordCall('subagent_list', params)
            return result('subagent_list')
        },
    })
}
