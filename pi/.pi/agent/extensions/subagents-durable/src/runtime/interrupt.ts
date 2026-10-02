/**
 * Interrupt implementation.
 *
 * Interruption aborts the target conversation's ordinary work, including its
 * queued inputs, while preserving its identity and any independent background
 * descendants. Root and self targets are rejected.
 */

import type { Context } from '@earendil-works/chord'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { isRootPath, resolveTarget } from '../domain/agent-path.js'
import { callerInfo, requireAgent, type RuntimeDeps } from './context.js'

export interface InterruptArgs {
    readonly target: string
}

export type InterruptDetails = {
    readonly status: 'Interrupted'
    readonly target: string
}

export async function interruptAgent(
    _deps: RuntimeDeps,
    api: ToolExecutionApi,
    args: InterruptArgs,
    context: Context
): Promise<InterruptDetails> {
    const caller = await callerInfo(api, context)
    const targetPath = resolveTarget(caller.path, args.target)
    if (isRootPath(targetPath) || targetPath === caller.path) {
        throw new Error(
            'interrupt_agent cannot target the root agent or itself.'
        )
    }
    const target = await requireAgent(api, context, targetPath)
    const handle = await api.conversation(target.conversationId, context)
    if (handle === undefined) {
        throw new Error(`Conversation ${target.conversationId} is missing.`)
    }
    await handle.abort(context)
    return { status: 'Interrupted', target: targetPath }
}
