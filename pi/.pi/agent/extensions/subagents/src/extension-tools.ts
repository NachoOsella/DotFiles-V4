/**
 * Collaboration tool adapters. Shared by the root extension registration
 * and by child SDK sessions (recursive spawn). No orchestration lives
 * here; every handler delegates to SubagentCoordinator.
 */

import { Text } from '@earendil-works/pi-tui'
import type { AgentPath } from './ids.ts'
import type { ToolCallId } from './ids.ts'
import type { SubagentCoordinator } from './coordinator.ts'
import {
    FollowupTaskParams,
    InterruptAgentParams,
    ListAgentsParams,
    SendMessageParams,
    SpawnAgentParams,
    TOOL_FOLLOWUP_TASK,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
    TOOL_SEND_MESSAGE,
    TOOL_SPAWN_AGENT,
    TOOL_WAIT_AGENT,
    WaitAgentParams,
    assertNoForbiddenTools,
    plannedV2Tools,
} from './tool-specs.ts'

export interface ToolContextLike {
    readonly sessionManager: {
        getSessionId: () => string
    }
    readonly cwd: string
}

function textResult(text: string, details?: unknown) {
    return {
        content: [{ type: 'text' as const, text }],
        details,
    }
}

function callerOf(
    manager: SubagentCoordinator,
    ctx: ToolContextLike | undefined,
    fixedCaller?: AgentPath
): AgentPath {
    if (fixedCaller) return fixedCaller
    try {
        const sessionId = ctx?.sessionManager.getSessionId()
        return manager.callerFromSession(sessionId)
    } catch {
        return '/root' as AgentPath
    }
}

export function buildToolHandlers(manager: SubagentCoordinator) {
    return {
        async spawn(
            caller: AgentPath,
            params: {
                message: string
                task_name: string
                agent_type?: string
                model?: string
                reasoning_effort?: string
                fork_turns?: string
            },
            _ctx: ToolContextLike | undefined,
            toolCallId: string
        ) {
            const result = await manager.spawn({
                caller,
                taskName: params.task_name,
                message: params.message,
                forkTurns: params.fork_turns,
                agentType: params.agent_type,
                model: params.model,
                reasoningEffort: params.reasoning_effort,
                callId: toolCallId as ToolCallId,
            })
            return textResult(`Spawned ${result.path}.`, {
                task_name: result.path,
            })
        },
        async send(
            caller: AgentPath,
            params: { target: string; message: string },
            toolCallId: string
        ) {
            await manager.sendMessage({
                caller,
                target: params.target,
                message: params.message,
                callId: toolCallId as ToolCallId,
            })
            return textResult('Message queued.', { delivered: true })
        },
        async followup(
            caller: AgentPath,
            params: { target: string; message: string },
            toolCallId: string
        ) {
            await manager.followup({
                caller,
                target: params.target,
                message: params.message,
                callId: toolCallId as ToolCallId,
            })
            return textResult('Follow-up queued.', { delivered: true })
        },
        async wait(caller: AgentPath, params: { timeout_ms?: number }) {
            const result = await manager.wait({
                caller,
                timeoutMs: params.timeout_ms,
            })
            return textResult(result.message, { timed_out: result.timedOut })
        },
        async interrupt(
            caller: AgentPath,
            params: { target: string },
            toolCallId: string
        ) {
            const status = await manager.interrupt({
                caller,
                target: params.target,
                callId: toolCallId as ToolCallId,
            })
            return textResult(`Target status: ${status._tag}.`, {
                status: status._tag,
            })
        },
        list(caller: AgentPath, params: { path_prefix?: string }) {
            const agents = manager.list(caller, params.path_prefix)
            if (agents.length === 0)
                return textResult('No subagents.', { agents: [] })
            const lines = agents.map(
                (a) =>
                    `${a.status === 'Running' ? '●' : a.status === 'Completed' ? '✓' : a.status === 'Errored' ? '!' : '○'} ${a.path} ${a.status} ${a.residency}`
            )
            return textResult(lines.join('\n'), { agents })
        },
    }
}

interface PiToolDefinition {
    name: string
    label: string
    description: string
    parameters: unknown
    execute: (
        toolCallId: string,
        params: never,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: never
    ) => Promise<never>
    renderCall?: (args: never, theme: never) => unknown
    renderResult?: (result: never, options: never, theme: never) => unknown
}

/** Root tool definitions for pi.registerTool (caller from session). */
export function buildRootToolDefinitions(manager: SubagentCoordinator) {
    const handlers = buildToolHandlers(manager)
    const resolveCaller = (ctx: ToolContextLike) => callerOf(manager, ctx)

    const renderCall =
        (title: string) =>
        (
            args: unknown,
            theme: {
                fg: (name: string, text: string) => string
                bold: (text: string) => string
            }
        ) =>
            new Text(
                `${theme.fg('toolTitle', theme.bold(`${title} `))}${theme.fg('muted', previewArgs(args))}`,
                0,
                0
            )

    return [
        {
            name: TOOL_SPAWN_AGENT,
            label: 'Spawn Agent',
            description:
                'Create a subagent for one bounded task. Returns the canonical task path.',
            parameters: SpawnAgentParams,
            async execute(
                toolCallId: string,
                params: {
                    message: string
                    task_name: string
                    agent_type?: string
                    model?: string
                    reasoning_effort?: string
                    fork_turns?: string
                },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.spawn(
                    resolveCaller(ctx),
                    params,
                    ctx,
                    toolCallId
                )
            },
            renderCall: renderCall('spawn_agent'),
        },
        {
            name: TOOL_SEND_MESSAGE,
            label: 'Send Message',
            description:
                'Queue a message to an agent without triggering a turn.',
            parameters: SendMessageParams,
            async execute(
                toolCallId: string,
                params: { target: string; message: string },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.send(resolveCaller(ctx), params, toolCallId)
            },
            renderCall: renderCall('send_message'),
        },
        {
            name: TOOL_FOLLOWUP_TASK,
            label: 'Followup Task',
            description:
                'Queue NEW_TASK on an agent, starting a turn when idle.',
            parameters: FollowupTaskParams,
            async execute(
                toolCallId: string,
                params: { target: string; message: string },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.followup(resolveCaller(ctx), params, toolCallId)
            },
            renderCall: renderCall('followup_task'),
        },
        {
            name: TOOL_WAIT_AGENT,
            label: 'Wait Agent',
            description:
                'Wait for agent activity. Returns a status string, never child output.',
            parameters: WaitAgentParams,
            async execute(
                _toolCallId: string,
                params: { timeout_ms?: number },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.wait(resolveCaller(ctx), params)
            },
            renderCall: renderCall('wait_agent'),
        },
        {
            name: TOOL_INTERRUPT_AGENT,
            label: 'Interrupt Agent',
            description:
                'Interrupt an agent turn without deleting its identity.',
            parameters: InterruptAgentParams,
            async execute(
                toolCallId: string,
                params: { target: string },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.interrupt(
                    resolveCaller(ctx),
                    params,
                    toolCallId
                )
            },
            renderCall: renderCall('interrupt_agent'),
        },
        {
            name: TOOL_LIST_AGENTS,
            label: 'List Agents',
            description: 'List logical agents without loading their sessions.',
            parameters: ListAgentsParams,
            async execute(
                _toolCallId: string,
                params: { path_prefix?: string },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.list(resolveCaller(ctx), params)
            },
            renderCall: renderCall('list_agents'),
        },
    ] as unknown as PiToolDefinition[]
}

/** Child SDK tools with a fixed caller (recursive spawn support). */
export function buildChildToolDefinitions(
    manager: SubagentCoordinator,
    caller: AgentPath
) {
    const handlers = buildToolHandlers(manager)
    return [
        {
            name: TOOL_SPAWN_AGENT,
            label: 'Spawn Agent',
            description: 'Create a nested subagent for one bounded task.',
            parameters: SpawnAgentParams,
            async execute(
                toolCallId: string,
                params: {
                    message: string
                    task_name: string
                    agent_type?: string
                    model?: string
                    reasoning_effort?: string
                    fork_turns?: string
                }
            ) {
                return handlers.spawn(caller, params, undefined, toolCallId)
            },
        },
        {
            name: TOOL_SEND_MESSAGE,
            label: 'Send Message',
            description:
                'Queue a message to an agent without triggering a turn.',
            parameters: SendMessageParams,
            async execute(
                toolCallId: string,
                params: { target: string; message: string }
            ) {
                return handlers.send(caller, params, toolCallId)
            },
        },
        {
            name: TOOL_FOLLOWUP_TASK,
            label: 'Followup Task',
            description:
                'Queue NEW_TASK on an agent, starting a turn when idle.',
            parameters: FollowupTaskParams,
            async execute(
                toolCallId: string,
                params: { target: string; message: string }
            ) {
                return handlers.followup(caller, params, toolCallId)
            },
        },
        {
            name: TOOL_WAIT_AGENT,
            label: 'Wait Agent',
            description: 'Wait for agent activity.',
            parameters: WaitAgentParams,
            async execute(
                _toolCallId: string,
                params: { timeout_ms?: number }
            ) {
                return handlers.wait(caller, params)
            },
        },
        {
            name: TOOL_INTERRUPT_AGENT,
            label: 'Interrupt Agent',
            description:
                'Interrupt an agent turn without deleting its identity.',
            parameters: InterruptAgentParams,
            async execute(toolCallId: string, params: { target: string }) {
                return handlers.interrupt(caller, params, toolCallId)
            },
        },
        {
            name: TOOL_LIST_AGENTS,
            label: 'List Agents',
            description: 'List logical agents without loading their sessions.',
            parameters: ListAgentsParams,
            async execute(
                _toolCallId: string,
                params: { path_prefix?: string }
            ) {
                return handlers.list(caller, params)
            },
        },
    ] as unknown as PiToolDefinition[]
}

/** Validate the planned family before registration. */
export function validateToolPlan(waitAgentEnabled: boolean): string[] {
    const planned = plannedV2Tools({ waitAgentEnabled })
    assertNoForbiddenTools(planned)
    return planned
}

function previewArgs(args: unknown): string {
    try {
        const text = JSON.stringify(args)
        return text.length > 120 ? `${text.slice(0, 120)}…` : text
    } catch {
        return ''
    }
}
