/**
 * Native tool registrations.
 *
 * Tools are thin adapters: parsing, validation, and durable work live in
 * `src/runtime`. Spawn, send, followup, wait, and list are replay-safe;
 * interrupt is intentionally replay-unsafe because repeating it after a crash
 * could stop newer work.
 */

import { defineTool } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type {
    ToolExecutionResult,
    ToolRegistration,
} from '@earendil-works/pi-durable'
import { listAgents } from '../runtime/list.js'
import { interruptAgent } from '../runtime/interrupt.js'
import { followupTask, sendMessage } from '../runtime/messaging.js'
import { spawnAgent, type SpawnArgs } from '../runtime/spawn.js'
import { waitAgent, type WaitArgs } from '../runtime/waiting.js'
import {
    FOLLOWUP_TASK_TOOL,
    INTERRUPT_AGENT_TOOL,
    LIST_AGENTS_TOOL,
    SEND_MESSAGE_TOOL,
    SPAWN_AGENT_TOOL,
    WAIT_AGENT_TOOL,
    type RuntimeDeps,
} from '../runtime/context.js'
import {
    buildSpawnAgentParams,
    buildWaitAgentParams,
    FollowupTaskParams,
    InterruptAgentParams,
    ListAgentsParams,
    SendMessageParams,
} from './schemas.js'

export {
    FOLLOWUP_TASK_TOOL,
    INTERRUPT_AGENT_TOOL,
    LIST_AGENTS_TOOL,
    SEND_MESSAGE_TOOL,
    SPAWN_AGENT_TOOL,
    WAIT_AGENT_TOOL,
} from '../runtime/context.js'
export { buildSpawnAgentParams, buildWaitAgentParams } from './schemas.js'
export type { RuntimeDeps } from '../runtime/context.js'

function textResult<T extends JsonValue>(
    details: T,
    text: string
): ToolExecutionResult<T> {
    return {
        content: [{ type: 'text' as const, text }],
        details,
    }
}

/** Build the enabled tool registrations for one extension instance. */
export function buildTools(deps: RuntimeDeps): ToolRegistration[] {
    const tools: ToolRegistration[] = [
        defineTool({
            name: SPAWN_AGENT_TOOL,
            description:
                'Create a child agent asynchronously. Returns immediately; the child runs in its own durable conversation and reports its final answer back to its direct parent. Then continue with other work or wait_agent.',
            parameters: buildSpawnAgentParams(deps.config),
            replay: 'safe',
            async execute(args, api, context) {
                const outcome = await spawnAgent(
                    deps,
                    api,
                    args as unknown as SpawnArgs,
                    context
                )
                return textResult(
                    outcome.details,
                    JSON.stringify(outcome.details)
                )
            },
        }),
        defineTool({
            name: SEND_MESSAGE_TOOL,
            description:
                'Send a passive message to another agent. It adds context without starting a turn and is queued at the next boundary while the target is busy.',
            parameters: SendMessageParams,
            replay: 'safe',
            async execute(args, api, context) {
                const result = await sendMessage(deps, api, args, context)
                return textResult(result, JSON.stringify(result))
            },
        }),
        defineTool({
            name: FOLLOWUP_TASK_TOOL,
            description:
                'Send new work to an existing agent. By default it steers the running target; mode "followUp" queues it after the current answer. The target reports its answer to its direct parent.',
            parameters: FollowupTaskParams,
            replay: 'safe',
            async execute(args, api, context) {
                const result = await followupTask(deps, api, args, context)
                return textResult(result, JSON.stringify(result))
            },
        }),
        defineTool({
            name: WAIT_AGENT_TOOL,
            description:
                'Wait for activity without consuming any answer. By default it wakes on the caller inbox; optional targets additionally wait for their current work and pending reporters to settle. A timeout ends only the observation.',
            parameters: buildWaitAgentParams(deps.config),
            replay: 'safe',
            async execute(args, api, context) {
                const result = await waitAgent(
                    deps,
                    api,
                    args as unknown as WaitArgs,
                    context
                )
                return textResult(result, result.message)
            },
        }),
        defineTool({
            name: INTERRUPT_AGENT_TOOL,
            description:
                'Stop the target agent current work and withdraw its queued inputs. Its identity and independent background descendants survive. Replay-unsafe: a rerun could stop newer work.',
            parameters: InterruptAgentParams,
            replay: 'unsafe',
            async execute(args, api, context) {
                const result = await interruptAgent(deps, api, args, context)
                return textResult(result, JSON.stringify(result))
            },
        }),
        defineTool({
            name: LIST_AGENTS_TOOL,
            description:
                'List registered agents with their path, status, role, model, parent, and running/waiting state.',
            parameters: ListAgentsParams,
            replay: 'safe',
            async execute(args, api, context) {
                const result = await listAgents(deps, api, args, context)
                return textResult(result, JSON.stringify(result))
            },
        }),
    ]

    if (!deps.config.waitAgentEnabled) {
        return tools.filter((tool) => tool.name !== WAIT_AGENT_TOOL)
    }
    return tools
}
