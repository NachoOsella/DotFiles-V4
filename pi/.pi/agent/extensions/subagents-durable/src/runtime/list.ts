/**
 * List implementation.
 *
 * A read-only projection of the session registry plus each conversation's
 * native live state and its most recent own assistant result. `/root` is
 * included even though it has no registry record.
 *
 * Terminal status comes from the newest assistant entry the conversation owns:
 * entries inherited from a fork have IDs at or below the fork point and are
 * ignored, so a forked child never reports its parent's answer. The obsolete
 * loaded/unloaded residency concept is intentionally dropped; `agent_status`
 * preserves the legacy key.
 */

import type { Context } from '@earendil-works/chord'
import {
    AgentDoc,
    InboxDoc,
    LiveDoc,
    ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
    ConversationId,
    ToolExecutionApi,
} from '@earendil-works/pi-durable'
import { ROOT_PATH, pathMatchesPrefix } from '../domain/agent-path.js'
import { SubagentsDoc } from '../state/subagents-doc.js'
import { WAIT_AGENT_TOOL } from './context.js'
import { ownGenerationStatuses } from './status.js'
import type { RuntimeDeps } from './context.js'

export interface ListArgs {
    readonly path_prefix?: string
}

export type ListedAgent = {
    readonly agent_name: string
    readonly agent_status:
        | 'PendingInit'
        | 'Running'
        | 'Waiting'
        | 'Completed'
        | 'Errored'
        | 'Interrupted'
    readonly role?: string
    readonly model?: string
    readonly thinking_level?: string
    readonly parent_path: string | null
    readonly has_pending_mail: boolean
    readonly running: boolean
    readonly waiting: boolean
}

export type ListDetails = {
    readonly agents: ListedAgent[]
}

type Target = {
    readonly path: string
    readonly parentPath: string | null
    readonly conversationId: ConversationId
    readonly role?: string
}

export async function listAgents(
    _deps: RuntimeDeps,
    api: ToolExecutionApi,
    args: ListArgs,
    context: Context
): Promise<ListDetails> {
    const state = await api.snapshot(SubagentsDoc, context)
    const targets: Target[] = [
        {
            path: ROOT_PATH,
            parentPath: null,
            conversationId: ROOT_CONVERSATION_ID,
        },
        ...Object.values(state?.agents ?? {}).map((agent) => ({
            path: agent.path,
            parentPath: agent.parentPath,
            conversationId: agent.conversationId,
            ...(agent.role === undefined ? {} : { role: agent.role }),
        })),
    ]
    const selected = targets
        .filter((target) =>
            pathMatchesPrefix(target.path, args.path_prefix ?? '')
        )
        .sort((left, right) => {
            if (left.path === right.path) return 0
            return left.path < right.path ? -1 : 1
        })
    const terminal = await api.commit(
        (tx) =>
            ownGenerationStatuses(
                tx,
                selected.map((target) => target.conversationId)
            ),
        context
    )
    const agents = await Promise.all(
        selected.map(async (target) => {
            const [agent, live, inbox] = await Promise.all([
                api.snapshot(AgentDoc, target.conversationId, context),
                api.snapshot(LiveDoc, target.conversationId, context),
                api.snapshot(InboxDoc, target.conversationId, context),
            ])
            const running = live?.run !== undefined
            const waiting =
                live?.tools?.some(
                    (slot) =>
                        slot.name === WAIT_AGENT_TOOL &&
                        slot.status === 'running'
                ) === true
            const model = agent?.model
            return {
                agent_name: target.path,
                agent_status: waiting
                    ? ('Waiting' as const)
                    : running
                      ? ('Running' as const)
                      : (terminal.get(target.conversationId)?.status ??
                        'PendingInit'),
                ...(target.role === undefined ? {} : { role: target.role }),
                ...(model === undefined
                    ? {}
                    : { model: `${model.provider}/${model.modelId}` }),
                ...(agent?.thinkingLevel === undefined
                    ? {}
                    : { thinking_level: agent.thinkingLevel }),
                parent_path: target.parentPath,
                has_pending_mail: (inbox?.items.length ?? 0) > 0,
                running,
                waiting,
            } satisfies ListedAgent
        })
    )
    return { agents }
}
