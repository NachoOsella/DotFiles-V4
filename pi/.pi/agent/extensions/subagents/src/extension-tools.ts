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
    buildSpawnAgentParams,
    TOOL_FOLLOWUP_TASK,
    TOOL_INTERRUPT_AGENT,
    TOOL_LIST_AGENTS,
    TOOL_SEND_MESSAGE,
    TOOL_SPAWN_AGENT,
    TOOL_WAIT_AGENT,
    buildWaitAgentParams,
    assertNoForbiddenTools,
    plannedV2Tools,
} from './tool-specs.ts'
import { COLLABORATION_TOOL_PROMPTS } from './prompts.ts'

export interface ToolContextLike {
    readonly sessionManager: {
        getSessionId: () => string
    }
    readonly cwd: string
}

function structuredResult(details: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(details),
            },
        ],
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
            if (manager.getConfig().hideSpawnAgentMetadata) {
                return structuredResult({ task_name: result.path })
            }
            const record = manager.getRecordByPath(result.path)
            return structuredResult({
                task_name: result.path,
                ...(record?.role ? { agent_type: record.role } : {}),
                ...(record ? { model: record.model } : {}),
                ...(record?.thinkingLevel
                    ? { thinking_level: record.thinkingLevel }
                    : {}),
                ...(params.fork_turns ? { fork_turns: params.fork_turns } : {}),
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
            return structuredResult({ delivered: true })
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
            return structuredResult({ delivered: true })
        },
        async wait(caller: AgentPath, params: { timeout_ms?: number }) {
            const result = await manager.wait({
                caller,
                timeoutMs: params.timeout_ms,
            })
            return structuredResult({
                message: result.message,
                timed_out: result.timedOut,
            })
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
            return structuredResult({ status: status._tag })
        },
        list(caller: AgentPath, params: { path_prefix?: string }) {
            const agents = manager.list(caller, params.path_prefix)
            return structuredResult({
                agents: agents.map((agent) => ({
                    agent_name: agent.path,
                    agent_status: agent.status,
                    residency: agent.residency,
                    role: agent.role,
                    model: agent.model,
                    thinking_level: manager.getRecordByPath(agent.path)
                        ?.thinkingLevel,
                    parent_path: agent.parentPath,
                    has_pending_mail: agent.hasPendingMail,
                    running: agent.running,
                })),
            })
        },
    }
}

interface PiToolDefinition {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: readonly string[]
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
    const config = manager.getConfig()
    const spawnAgentParams = buildSpawnAgentParams(config)
    const waitAgentParams = buildWaitAgentParams(config)
    const resolveCaller = (ctx: ToolContextLike) => callerOf(manager, ctx)

    interface ThemeLike {
        fg: (name: string, text: string) => string
        bold: (text: string) => string
    }

    interface RenderContext {
        args?: unknown
    }

    interface RenderOptions {
        expanded?: boolean
        isPartial?: boolean
        isError?: boolean
    }

    interface RenderResultValue {
        content?: Array<{ text?: unknown }>
        details?: unknown
    }

    const asRecord = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : {}

    const oneLine = (value: unknown, max: number): string => {
        const text = String(value ?? '')
            .replace(/\s+/g, ' ')
            .trim()
        return text.length > max ? `${text.slice(0, max)}…` : text
    }

    const shortName = (path: unknown): string => {
        const text = String(path ?? '')
        const idx = text.lastIndexOf('/')
        return idx >= 0 ? text.slice(idx + 1) : text
    }

    const shortModel = (model: unknown): string => {
        const text = String(model ?? '')
        const idx = text.lastIndexOf('/')
        return idx >= 0 ? text.slice(idx + 1) : text
    }

    const statusGlyph = (status: unknown, theme: ThemeLike): string => {
        switch (status) {
            case 'Running':
                return theme.fg('accent', '●')
            case 'Completed':
                return theme.fg('success', '✓')
            case 'Errored':
                return theme.fg('error', '!')
            case 'Interrupted':
                return theme.fg('warning', '◐')
            default:
                return theme.fg('dim', '○')
        }
    }

    const errorText = (
        result: RenderResultValue,
        theme: ThemeLike
    ): string | null => {
        const content = result.content
            ?.map((part) => String(part?.text ?? ''))
            .join(' ')
            .trim()
        return content ? theme.fg('error', oneLine(content, 160)) : null
    }

    const renderSpawnCall = (args: unknown, theme: ThemeLike) => {
        const params = asRecord(args)
        const head = `${theme.fg('toolTitle', theme.bold('spawn_agent '))}${theme.fg('accent', theme.bold(String(params.task_name ?? '')))}`
        const meta = [
            params.agent_type ? String(params.agent_type) : '',
            params.model ? shortModel(params.model) : '',
            params.reasoning_effort
                ? `reasoning:${params.reasoning_effort}`
                : '',
            `fork:${params.fork_turns ?? 'all'}`,
        ]
            .filter(Boolean)
            .join(' · ')
        const preview = oneLine(params.message, 90)
        const lines = meta ? [head, theme.fg('dim', `  ${meta}`)] : [head]
        if (preview) lines.push(theme.fg('muted', `  “${preview}”`))
        return new Text(lines.join('\n'), 0, 0)
    }

    const renderSpawnResult = (
        result: RenderResultValue,
        options: RenderOptions,
        theme: ThemeLike,
        context: RenderContext
    ) => {
        if (options.isPartial)
            return new Text(theme.fg('dim', '◌ spawning…'), 0, 0)
        if (options.isError)
            return new Text(
                errorText(result, theme) ?? theme.fg('error', 'spawn failed'),
                0,
                0
            )
        const details = asRecord(result.details)
        const params = asRecord(context.args)
        const head = `${theme.fg('success', '✓')} ${details.task_name ? String(details.task_name) : oneLine(params.task_name, 60)}`
        if (!options.expanded) return new Text(head, 0, 0)
        const meta = [
            details.agent_type ? `type:${details.agent_type}` : '',
            details.model ? shortModel(details.model) : '',
            details.thinking_level ? `thinking:${details.thinking_level}` : '',
            details.fork_turns ? `fork:${details.fork_turns}` : '',
        ]
            .filter(Boolean)
            .join(' · ')
        return new Text(
            meta ? `${head}\n${theme.fg('dim', `  ${meta}`)}` : head,
            0,
            0
        )
    }

    const renderMessageCall =
        (title: string) => (args: unknown, theme: ThemeLike) => {
            const params = asRecord(args)
            const head = `${theme.fg('toolTitle', theme.bold(`${title} `))}${theme.fg('accent', oneLine(params.target, 48))}`
            const preview = oneLine(params.message, 90)
            return new Text(
                preview
                    ? `${head}\n${theme.fg('muted', `  “${preview}”`)}`
                    : head,
                0,
                0
            )
        }

    const renderMessageResult = (
        result: RenderResultValue,
        options: RenderOptions,
        theme: ThemeLike,
        context: RenderContext
    ) => {
        if (options.isPartial)
            return new Text(theme.fg('dim', '◌ delivering…'), 0, 0)
        if (options.isError)
            return new Text(
                errorText(result, theme) ??
                    theme.fg('error', 'delivery failed'),
                0,
                0
            )
        const target = oneLine(asRecord(context.args).target, 48)
        return new Text(
            `${theme.fg('success', '✓ delivered')} ${theme.fg('dim', `→ ${target}`)}`,
            0,
            0
        )
    }

    const formatTimeout = (timeoutMs: unknown): string => {
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))
            return 'default timeout'
        return timeoutMs >= 1000
            ? `${Math.round(timeoutMs / 1000)}s`
            : `${timeoutMs}ms`
    }

    const renderWaitResult = (
        result: RenderResultValue,
        options: RenderOptions,
        theme: ThemeLike,
        context: RenderContext
    ) => {
        if (options.isPartial)
            return new Text(theme.fg('dim', '◌ waiting for agents…'), 0, 0)
        if (options.isError)
            return new Text(
                errorText(result, theme) ?? theme.fg('error', 'wait failed'),
                0,
                0
            )
        const details = asRecord(result.details)
        const message = String(details.message ?? '')
        const after = formatTimeout(asRecord(context.args).timeout_ms)
        if (details.timed_out)
            return new Text(
                `${theme.fg('warning', '○ timed out')} ${theme.fg('dim', `· ${after}`)}`,
                0,
                0
            )
        if (/interrupted/i.test(message)) {
            const note = message.replace(/^[^.]*\.\s*/, '')
            const head = `${theme.fg('warning', '◐ interrupted')} ${theme.fg('dim', 'by new input')}`
            return new Text(
                note && note !== message
                    ? `${head}\n${theme.fg('dim', `  ${oneLine(note, 120)}`)}`
                    : head,
                0,
                0
            )
        }
        const note = message.replace(/^Wait completed\.\s*/, '')
        const head = theme.fg('success', '✓ activity')
        return new Text(
            note && note !== message
                ? `${head}\n${theme.fg('dim', `  ${oneLine(note, 120)}`)}`
                : head,
            0,
            0
        )
    }

    const renderInterruptResult = (
        result: RenderResultValue,
        options: RenderOptions,
        theme: ThemeLike,
        context: RenderContext
    ) => {
        if (options.isPartial)
            return new Text(theme.fg('dim', '◌ interrupting…'), 0, 0)
        if (options.isError)
            return new Text(
                errorText(result, theme) ??
                    theme.fg('error', 'interrupt failed'),
                0,
                0
            )
        const details = asRecord(result.details)
        const target = oneLine(asRecord(context.args).target, 48)
        const status = String(details.status ?? '')
        return new Text(
            `${theme.fg('warning', '■ interrupt')} ${theme.fg('accent', target)} ${theme.fg('dim', `· now ${status || 'unknown'}`)}`,
            0,
            0
        )
    }

    const renderListResult = (
        result: RenderResultValue,
        options: RenderOptions,
        theme: ThemeLike
    ) => {
        if (options.isPartial)
            return new Text(theme.fg('dim', '◌ listing agents…'), 0, 0)
        if (options.isError)
            return new Text(
                errorText(result, theme) ?? theme.fg('error', 'list failed'),
                0,
                0
            )
        const agents = asRecord(result.details).agents
        const rows = Array.isArray(agents) ? agents : []
        const head = theme.fg(
            'muted',
            `${rows.length} agent${rows.length === 1 ? '' : 's'}`
        )
        if (rows.length === 0) return new Text(head, 0, 0)
        const lines = rows.map((entry) => {
            const agent = asRecord(entry)
            const name = theme.fg('accent', oneLine(agent.agent_name, 40))
            const status = String(agent.agent_status ?? '')
            const extra = options.expanded
                ? [
                      agent.role ? String(agent.role) : '',
                      agent.model ? shortModel(agent.model) : '',
                      agent.thinking_level
                          ? `thinking:${agent.thinking_level}`
                          : '',
                      agent.residency ? String(agent.residency) : '',
                  ]
                      .filter(Boolean)
                      .join(' · ')
                : [
                      agent.thinking_level
                          ? `thinking:${agent.thinking_level}`
                          : '',
                      String(agent.residency ?? ''),
                  ]
                      .filter(Boolean)
                      .join(' · ')
            const meta = extra ? theme.fg('dim', ` · ${extra}`) : ''
            const mail = agent.has_pending_mail ? theme.fg('warning', ' ✉') : ''
            return `${statusGlyph(status, theme)} ${name}${mail} ${theme.fg('dim', status)}${meta}`
        })
        return new Text(`${head}\n${lines.join('\n')}`, 0, 0)
    }

    const tools = [
        {
            name: TOOL_SPAWN_AGENT,
            label: 'Spawn Agent',
            ...COLLABORATION_TOOL_PROMPTS.spawn_agent,
            parameters: spawnAgentParams,
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
            renderCall: renderSpawnCall,
            renderResult: renderSpawnResult,
        },
        {
            name: TOOL_SEND_MESSAGE,
            label: 'Send Message',
            ...COLLABORATION_TOOL_PROMPTS.send_message,
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
            renderCall: renderMessageCall('send_message'),
            renderResult: renderMessageResult,
        },
        {
            name: TOOL_FOLLOWUP_TASK,
            label: 'Followup Task',
            ...COLLABORATION_TOOL_PROMPTS.followup_task,
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
            renderCall: renderMessageCall('followup_task'),
            renderResult: renderMessageResult,
        },
        {
            name: TOOL_WAIT_AGENT,
            label: 'Wait Agent',
            ...COLLABORATION_TOOL_PROMPTS.wait_agent,
            parameters: waitAgentParams,
            async execute(
                _toolCallId: string,
                params: { timeout_ms?: number },
                _signal: AbortSignal | undefined,
                _onUpdate: undefined,
                ctx: ToolContextLike
            ) {
                return handlers.wait(resolveCaller(ctx), params)
            },
            renderCall: (args: unknown, theme: ThemeLike) =>
                new Text(
                    `${theme.fg('toolTitle', theme.bold('wait_agent '))}${theme.fg('muted', formatTimeout(asRecord(args).timeout_ms))}`,
                    0,
                    0
                ),
            renderResult: renderWaitResult,
        },
        {
            name: TOOL_INTERRUPT_AGENT,
            label: 'Interrupt Agent',
            ...COLLABORATION_TOOL_PROMPTS.interrupt_agent,
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
            renderCall: (args: unknown, theme: ThemeLike) =>
                new Text(
                    `${theme.fg('toolTitle', theme.bold('interrupt_agent '))}${theme.fg('accent', oneLine(asRecord(args).target, 48))}`,
                    0,
                    0
                ),
            renderResult: renderInterruptResult,
        },
        {
            name: TOOL_LIST_AGENTS,
            label: 'List Agents',
            ...COLLABORATION_TOOL_PROMPTS.list_agents,
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
            renderCall: (args: unknown, theme: ThemeLike) => {
                const prefix = oneLine(asRecord(args).path_prefix, 40)
                const head = theme.fg('toolTitle', theme.bold('list_agents'))
                return new Text(
                    prefix
                        ? `${head} ${theme.fg('muted', `prefix “${prefix}”`)}`
                        : head,
                    0,
                    0
                )
            },
            renderResult: renderListResult,
        },
    ]
    return (config.waitAgentEnabled
        ? tools
        : tools.filter(
              (tool) => tool.name !== TOOL_WAIT_AGENT
          )) as unknown as PiToolDefinition[]
}

/** Child SDK tools with a fixed caller (recursive spawn support). */
export function buildChildToolDefinitions(
    manager: SubagentCoordinator,
    caller: AgentPath
) {
    const handlers = buildToolHandlers(manager)
    const config = manager.getConfig()
    const spawnAgentParams = buildSpawnAgentParams(config)
    const waitAgentParams = buildWaitAgentParams(config)
    const tools = [
        {
            name: TOOL_SPAWN_AGENT,
            label: 'Spawn Agent',
            ...COLLABORATION_TOOL_PROMPTS.spawn_agent,
            parameters: spawnAgentParams,
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
            ...COLLABORATION_TOOL_PROMPTS.send_message,
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
            ...COLLABORATION_TOOL_PROMPTS.followup_task,
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
            ...COLLABORATION_TOOL_PROMPTS.wait_agent,
            parameters: waitAgentParams,
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
            ...COLLABORATION_TOOL_PROMPTS.interrupt_agent,
            parameters: InterruptAgentParams,
            async execute(toolCallId: string, params: { target: string }) {
                return handlers.interrupt(caller, params, toolCallId)
            },
        },
        {
            name: TOOL_LIST_AGENTS,
            label: 'List Agents',
            ...COLLABORATION_TOOL_PROMPTS.list_agents,
            parameters: ListAgentsParams,
            async execute(
                _toolCallId: string,
                params: { path_prefix?: string }
            ) {
                return handlers.list(caller, params)
            },
        },
    ]
    return (config.waitAgentEnabled
        ? tools
        : tools.filter(
              (tool) => tool.name !== TOOL_WAIT_AGENT
          )) as unknown as PiToolDefinition[]
}

/** Validate the planned family before registration. */
export function validateToolPlan(waitAgentEnabled: boolean): string[] {
    const planned = plannedV2Tools({ waitAgentEnabled })
    assertNoForbiddenTools(planned)
    return planned
}
