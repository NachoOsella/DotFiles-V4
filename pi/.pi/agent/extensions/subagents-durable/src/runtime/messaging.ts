/**
 * Outbound messaging.
 *
 * `send_message` is a passive model-contributing write: it never starts a run
 * and Durable queues it at the next boundary while the target is busy. Durable
 * 1.0.0 task handles cannot submit writes, so the host's public
 * `Conversation.submit({ type: "write", ... })` is used through `submitWrite`.
 *
 * `followup_task` submits a NEW_TASK input to the target through a background
 * reporter, so the target's answer reaches its direct parent exactly once.
 */

import type { Context } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID, UserEntry } from '@earendil-works/pi-durable'
import type {
    ConversationId,
    SubmissionDraft,
    ToolExecutionApi,
} from '@earendil-works/pi-durable'
import {
    isRootPath,
    resolveTarget,
    type AgentPath,
} from '../domain/agent-path.js'
import { displayNameFor, formatEnvelope } from '../domain/communication.js'
import { OperationReceiptDoc } from '../state/subagents-doc.js'
import { ReporterTask } from '../tasks/reporter-task.js'
import {
    callerInfo,
    requireAgent,
    resolveConversationId,
    type RuntimeDeps,
} from './context.js'

export interface SendArgs {
    readonly target: string
    readonly message: string
}

export type SendDetails = {
    readonly delivered: true
    readonly target: string
}

export async function sendMessage(
    deps: RuntimeDeps,
    api: ToolExecutionApi,
    args: SendArgs,
    context: Context
): Promise<SendDetails> {
    assertNonEmpty(args.message)
    const caller = await callerInfo(api, context)
    const targetPath = resolveTarget(caller.path, args.target)
    const targetConversationId = await resolveConversationId(
        api,
        context,
        targetPath
    )
    const envelope = formatEnvelope(
        'MESSAGE',
        displayNameFor(targetPath),
        caller.path,
        args.message
    )
    const draft: Extract<SubmissionDraft, { type: 'write' }> = {
        type: 'write',
        requestId: `subagents.send:${api.taskId}`,
        entry: {
            kind: UserEntry.kind,
            model: [
                {
                    role: 'user',
                    content: envelope,
                    timestamp: Date.now(),
                },
            ],
        },
    }
    await deps.submitWrite(targetConversationId, draft, context)
    return { delivered: true, target: targetPath }
}

export interface FollowupArgs {
    readonly target: string
    readonly message: string
    readonly mode?: 'steer' | 'followUp'
}

export type FollowupDetails = {
    readonly delivered: true
    readonly target: string
    readonly mode: 'steer' | 'followUp'
}

export async function followupTask(
    _deps: RuntimeDeps,
    api: ToolExecutionApi,
    args: FollowupArgs,
    context: Context
): Promise<FollowupDetails> {
    assertNonEmpty(args.message)
    const caller = await callerInfo(api, context)
    const targetPath = resolveTarget(caller.path, args.target)
    if (isRootPath(targetPath)) {
        throw new Error('followup_task cannot target the root agent.')
    }
    const target = await requireAgent(api, context, targetPath)
    const mode = args.mode ?? 'steer'
    const envelope = formatEnvelope(
        'NEW_TASK',
        displayNameFor(targetPath),
        caller.path,
        args.message
    )
    const parentId = await resolveParentConversation(
        api,
        context,
        target.parentPath
    )

    await api.commit(async (tx) => {
        const receipt = await tx.doc(OperationReceiptDoc, api.taskId)
        if (receipt.reporterId !== undefined) return
        const reporterId = await tx.createTask(
            ReporterTask,
            {
                childPath: targetPath,
                childId: target.conversationId,
                parentPath: target.parentPath,
                parentId,
                content: envelope,
                whenBusy: mode,
            },
            {
                ownership: { kind: 'conversation' },
                conversationId: parentId,
                background: true,
            }
        )
        receipt.conversationId = target.conversationId
        receipt.reporterId = reporterId
    }, context)

    return { delivered: true, target: targetPath, mode }
}

async function resolveParentConversation(
    api: ToolExecutionApi,
    context: Context,
    parentPath: AgentPath
): Promise<ConversationId> {
    if (parentPath === '/root') return ROOT_CONVERSATION_ID
    const parent = await requireAgent(api, context, parentPath)
    return parent.conversationId
}

function assertNonEmpty(message: string): void {
    if (message.trim().length === 0) {
        throw new Error('Message must not be empty.')
    }
}
