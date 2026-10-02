/**
 * Spawn implementation.
 *
 * One atomic commit validates the name, nesting depth, and logical capacity,
 * creates the background anchor task, creates or forks the child conversation,
 * applies the native agent configuration, records the session registry entry,
 * and creates the background reporter that delivers the NEW_TASK envelope.
 * The task-scoped operation receipt makes a replay of the same tool call reuse
 * exactly what the first attempt created.
 */

import type { Context } from '@earendil-works/chord'
import { configure } from '@earendil-works/pi-durable'
import type {
    Agent,
    ConversationId,
    ModelRef,
    RegistrySnapshot,
    ToolExecutionApi,
    ToolRegistration,
} from '@earendil-works/pi-durable'
import {
    childDepth,
    joinAgentPath,
    type AgentPath,
} from '../domain/agent-path.js'
import { formatEnvelope, parseForkTurns } from '../domain/communication.js'
import {
    isThinkingLevel,
    resolveRole,
    type ResolvedAgentRole,
    type ThinkingLevel,
} from '../config/roles.js'
import {
    assembleChildPrompt,
    resolveConfiguredMode,
} from '../config/prompts.js'
import { selectFork } from '../runtime/forks.js'
import {
    agentCount,
    getAgentMetadata,
    OperationReceiptDoc,
    SubagentsDoc,
    type SpawnReceiptDetails,
} from '../state/subagents-doc.js'
import { AnchorTask } from '../tasks/anchor-task.js'
import { ReporterTask } from '../tasks/reporter-task.js'
import { SPAWN_AGENT_TOOL, callerInfo, type RuntimeDeps } from './context.js'

/** Entry kind carrying native fork omission edits. */
const FORK_EDIT_ENTRY_KIND = 'subagents.fork-edit'

export interface SpawnArgs {
    readonly task_name: string
    readonly message: string
    readonly agent_type?: string
    readonly model?: string
    readonly reasoning_effort?: string
    readonly fork_turns?: string
}

export type SpawnDetails = SpawnReceiptDetails & { readonly replayed?: true }

export interface SpawnOutcome {
    readonly details: SpawnDetails
    readonly conversationId: ConversationId
    readonly replayed: boolean
}

export async function spawnAgent(
    deps: RuntimeDeps,
    api: ToolExecutionApi,
    args: SpawnArgs,
    context: Context
): Promise<SpawnOutcome> {
    const prior = await api.snapshot(OperationReceiptDoc, api.taskId, context)
    if (
        prior?.conversationId !== undefined &&
        prior.spawnResult !== undefined
    ) {
        return {
            conversationId: prior.conversationId,
            replayed: true,
            details: { ...prior.spawnResult, replayed: true },
        }
    }
    if (args.message.trim().length === 0) {
        throw new Error('Message must not be empty.')
    }
    const caller = await callerInfo(api, context)
    const fork = parseForkTurns(args.fork_turns)
    const explicitModel = args.model
    const explicitThinking = args.reasoning_effort
    if (
        (explicitModel !== undefined || explicitThinking !== undefined) &&
        !deps.config.exposeSpawnAgentModelOverrides
    ) {
        throw new Error(
            'model and reasoning_effort overrides are not exposed; omit them.'
        )
    }
    if (
        fork.kind === 'all' &&
        (explicitModel !== undefined || explicitThinking !== undefined)
    ) {
        throw new Error(
            'model and reasoning_effort overrides are not allowed with fork_turns=all.'
        )
    }
    const thinkingOverride =
        explicitThinking === undefined
            ? undefined
            : parseThinkingLevel(explicitThinking)
    const role = resolveRole(
        deps.config,
        args.agent_type ?? (fork.kind === 'all' ? caller.role : undefined)
    )
    const childPath = joinAgentPath(caller.path, args.task_name)
    const parentAgent = await api.agent(context)
    const registry = api.registry
    const envelope = formatEnvelope(
        'NEW_TASK',
        args.task_name,
        caller.path,
        args.message
    )

    const created = await api.commit(async (tx) => {
        const forkSelection = await selectFork(
            tx,
            caller.conversationId,
            args.fork_turns
        )
        const receipt = await tx.doc(OperationReceiptDoc, api.taskId)
        if (
            receipt.conversationId !== undefined &&
            receipt.spawnResult !== undefined
        ) {
            return {
                conversationId: receipt.conversationId,
                replayed: true,
                details: { ...receipt.spawnResult, replayed: true as const },
            }
        }
        const state = await tx.doc(SubagentsDoc)
        if (getAgentMetadata(state, childPath) !== undefined) {
            throw new Error(`Agent ${childPath} already exists.`)
        }
        if (childDepth(childPath) > deps.config.maxDepth) {
            throw new Error('Agent depth limit reached.')
        }
        if (agentCount(state) >= deps.config.maxAgents) {
            throw new Error(
                `Agent capacity reached (maxAgents=${deps.config.maxAgents}).`
            )
        }

        const anchorId = await tx.createTask(AnchorTask, null, {
            ownership: { kind: 'conversation' },
            conversationId: caller.conversationId,
            background: true,
        })
        const child =
            forkSelection.at === undefined
                ? await tx.createConversation({
                      ownership: { kind: 'task', taskId: anchorId },
                  })
                : await tx.forkConversation(
                      caller.conversationId,
                      forkSelection.at,
                      { ownership: { kind: 'task', taskId: anchorId } }
                  )
        if (forkSelection.edits.length > 0) {
            await tx.appendEntry(child.id, {
                kind: FORK_EDIT_ENTRY_KIND,
                edits: forkSelection.edits,
            })
        }
        await configure(
            tx,
            child.id,
            buildAgentChange(
                deps,
                role,
                childPath,
                caller.path,
                explicitModel,
                thinkingOverride,
                parentAgent,
                registry
            )
        )
        const reporterId = await tx.createTask(
            ReporterTask,
            {
                childPath,
                childId: child.id,
                parentPath: caller.path,
                parentId: caller.conversationId,
                content: envelope,
                whenBusy: 'followUp',
            },
            {
                ownership: { kind: 'conversation' },
                conversationId: caller.conversationId,
                background: true,
            }
        )
        state.agents[childPath] = {
            name: args.task_name,
            path: childPath,
            parentPath: caller.path,
            conversationId: child.id,
            role: role.name,
            createdAt: Date.now(),
        }
        const details = spawnDetails(
            deps,
            role,
            childPath,
            args,
            parentAgent,
            thinkingOverride,
            explicitModel
        )
        receipt.conversationId = child.id
        receipt.reporterId = reporterId
        receipt.spawnResult = details
        return { conversationId: child.id, replayed: false, details }
    }, context)

    return created
}

function spawnDetails(
    deps: RuntimeDeps,
    role: ResolvedAgentRole,
    canonicalPath: string,
    args: SpawnArgs,
    parentAgent: Agent,
    thinkingOverride: ThinkingLevel | undefined,
    explicitModel: string | undefined
): SpawnReceiptDetails {
    if (deps.config.hideSpawnAgentMetadata) {
        return { task_name: canonicalPath }
    }
    const model = effectiveModel(role, explicitModel, parentAgent)
    const thinking =
        thinkingOverride ?? role.thinkingLevel ?? parentAgent.thinkingLevel
    return {
        task_name: canonicalPath,
        ...(role.name === 'default' ? {} : { agent_type: role.name }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking_level: thinking }),
        ...(args.fork_turns === undefined
            ? {}
            : { fork_turns: args.fork_turns }),
    }
}

/**
 * Explicit `model` beats a role default for `none`/`recent` spawns; a role
 * default applies for a full fork, where explicit overrides are rejected.
 */
function effectiveModel(
    role: ResolvedAgentRole,
    explicit: string | undefined,
    parentAgent: Agent
): string | undefined {
    if (explicit !== undefined) return explicit
    if (role.model !== undefined) return role.model
    const model = parentAgent.model
    return model === undefined
        ? undefined
        : `${model.provider}/${model.modelId}`
}

function buildAgentChange(
    deps: RuntimeDeps,
    role: ResolvedAgentRole,
    childPath: AgentPath,
    parentPath: AgentPath,
    explicitModel: string | undefined,
    thinkingOverride: ThinkingLevel | undefined,
    parentAgent: Agent,
    registry: RegistrySnapshot
): {
    model?: ModelRef
    thinkingLevel?: ThinkingLevel
    tools?:
        | readonly ToolRegistration[]
        | { readonly remove: readonly ToolRegistration[] }
    instructions?: string
} {
    const change: {
        model?: ModelRef
        thinkingLevel?: ThinkingLevel
        tools?:
            | readonly ToolRegistration[]
            | { readonly remove: readonly ToolRegistration[] }
        instructions?: string
    } = {}
    const model = explicitModel ?? role.model
    if (model !== undefined) change.model = parseModelRef(model)
    const thinking = thinkingOverride ?? role.thinkingLevel
    if (thinking !== undefined) change.thinkingLevel = thinking

    const atDepthLimit = childDepth(childPath) >= deps.config.maxDepth
    if (role.tools === undefined) {
        if (atDepthLimit) {
            const spawn = parentAgent.tools.filter(
                (tool) => tool.name === SPAWN_AGENT_TOOL
            )
            if (spawn.length > 0) change.tools = { remove: spawn }
        }
    } else {
        // Role tools are additions over the inherited set, never an
        // intersection: keep every inherited tool and every permitted
        // collaboration tool, add the resolved requests, then drop spawn at
        // the depth limit.
        const byName = new Map<string, ToolRegistration>()
        for (const tool of parentAgent.tools) byName.set(tool.name, tool)
        const available = new Map<string, ToolRegistration>()
        for (const entry of registry.tools()) {
            available.set(entry.tool.name, entry.tool)
        }
        for (const name of role.tools) {
            const tool = available.get(name)
            if (tool !== undefined) byName.set(name, tool)
        }
        if (atDepthLimit) byName.delete(SPAWN_AGENT_TOOL)
        change.tools = [...byName.values()]
    }

    const guidance = assembleChildPrompt({
        config: deps.config,
        mode: resolveConfiguredMode(
            deps.config,
            thinking ?? parentAgent.thinkingLevel
        ),
        activeSlotCount: deps.config.maxConcurrentExecutions,
        currentDepth: childDepth(childPath),
        role,
        path: childPath,
        parentPath,
    })
    change.instructions = mergeInstructions(parentAgent.instructions, guidance)
    return change
}

/** Keep the owner's inherited instructions and append the child guidance. */
function mergeInstructions(
    inherited: string | undefined,
    guidance: string
): string {
    if (inherited === undefined || inherited.trim().length === 0) {
        return guidance
    }
    return `${inherited}\n\n${guidance}`
}

function parseModelRef(value: string): ModelRef {
    const separator = value.indexOf('/')
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid model identity "${value}".`)
    }
    return {
        provider: value.slice(0, separator),
        modelId: value.slice(separator + 1),
    }
}

function parseThinkingLevel(value: string): ThinkingLevel {
    if (!isThinkingLevel(value)) {
        throw new Error(`Invalid reasoning_effort "${value}".`)
    }
    return value
}
