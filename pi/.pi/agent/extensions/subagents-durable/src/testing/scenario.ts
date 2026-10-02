/**
 * Scenario builders for reporter and ownership tests.
 *
 * These mirror what the native spawn tool does in one commit: a background
 * anchor task owns a new child conversation, the registry records the logical
 * identity, and a background reporter in the caller's conversation delivers one
 * work submission and reports the answer back.
 */

import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { formatEnvelope } from '../domain/communication.js'
import { AnchorTask } from '../tasks/anchor-task.js'
import { ReporterTask, type ReporterResult } from '../tasks/reporter-task.js'
import { SubagentsDoc } from '../state/subagents-doc.js'
import type { TestHarness } from './harness.js'

export type AgentConversation = {
    readonly anchorId: TaskId<null>
    readonly conversationId: ConversationId
    readonly path: string
    readonly parentPath: string
}

export type CreateAgentConversationOptions = {
    /** Canonical child path; also the registry key. */
    readonly path: string
    /** Canonical direct-parent path. */
    readonly parentPath: string
    /** Conversation that owns the anchor task. */
    readonly parentConversationId: ConversationId
    readonly role?: string
}

/**
 * Create one anchored child conversation and register its logical identity in
 * the same commit. The child inherits its owner conversation's agent document.
 */
export async function createAgentConversation(
    harness: TestHarness,
    options: CreateAgentConversationOptions
): Promise<AgentConversation> {
    const { harness: api, context } = harness
    return api.commit(async (tx) => {
        const state = await tx.doc(SubagentsDoc)
        const anchorId = await tx.createTask(AnchorTask, null, {
            ownership: { kind: 'conversation' },
            conversationId: options.parentConversationId,
            background: true,
        })
        const conversation = await tx.createConversation({
            ownership: { kind: 'task', taskId: anchorId },
        })
        state.agents[options.path] = {
            name: lastSegment(options.path),
            path: options.path,
            parentPath: options.parentPath,
            conversationId: conversation.id,
            ...(options.role === undefined ? {} : { role: options.role }),
            createdAt: Date.now(),
        }
        return {
            anchorId,
            conversationId: conversation.id,
            path: options.path,
            parentPath: options.parentPath,
        }
    }, context)
}

export type CreateReporterTaskOptions = {
    readonly childPath: string
    readonly childId: ConversationId
    readonly parentPath: string
    readonly parentId: ConversationId
    /** Already-rendered envelope delivered to the child. */
    readonly content: string
    readonly whenBusy?: 'steer' | 'followUp'
    readonly childRequestId?: string
}

/** Create one background reporter in the conversation it reports to. */
export async function createReporterTask(
    harness: TestHarness,
    options: CreateReporterTaskOptions
): Promise<TaskId<ReporterResult>> {
    const { harness: api, context } = harness
    return api.commit(
        (tx) =>
            tx.createTask(
                ReporterTask,
                {
                    childPath: options.childPath,
                    childId: options.childId,
                    parentPath: options.parentPath,
                    parentId: options.parentId,
                    content: options.content,
                    whenBusy: options.whenBusy ?? 'followUp',
                    ...(options.childRequestId === undefined
                        ? {}
                        : { childRequestId: options.childRequestId }),
                },
                {
                    ownership: { kind: 'conversation' },
                    conversationId: options.parentId,
                    background: true,
                }
            ),
        context
    )
}

export type ReporterScenarioOptions = {
    readonly childPath: string
    readonly parentPath: string
    readonly role?: string
    readonly whenBusy?: 'steer' | 'followUp'
    readonly content?: string
}

export type ReporterScenario = AgentConversation & {
    readonly rootId: ConversationId
    readonly reporterId: TaskId<ReporterResult>
    readonly content: string
}

/**
 * Root-configured convenience: create a root agent, one anchored child, and the
 * reporter that delivers a NEW_TASK to it.
 */
export async function createReporterScenario(
    harness: TestHarness,
    options: ReporterScenarioOptions
): Promise<ReporterScenario> {
    const root = await harness.harness.root(harness.context)
    await root.configure(
        {
            model: {
                provider: harness.provider,
                modelId: harness.modelId,
            },
        },
        harness.context
    )
    const agent = await createAgentConversation(harness, {
        path: options.childPath,
        parentPath: options.parentPath,
        parentConversationId: root.id,
        ...(options.role === undefined ? {} : { role: options.role }),
    })
    const name = lastSegment(options.childPath)
    const content =
        options.content ??
        formatEnvelope('NEW_TASK', name, options.parentPath, `Task for ${name}`)
    const reporterId = await createReporterTask(harness, {
        childPath: options.childPath,
        childId: agent.conversationId,
        parentPath: options.parentPath,
        parentId: root.id,
        content,
        whenBusy: options.whenBusy ?? 'followUp',
    })
    return { ...agent, rootId: root.id, reporterId, content }
}

function lastSegment(path: string): string {
    const index = path.lastIndexOf('/')
    return index >= 0 ? path.slice(index + 1) : path
}
