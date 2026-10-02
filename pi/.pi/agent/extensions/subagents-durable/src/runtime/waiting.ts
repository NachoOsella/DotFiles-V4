/**
 * Wait implementation.
 *
 * Waiting is synchronization only. It never consumes, returns, or withdraws
 * an answer, and cancelling it never aborts child work.
 *
 * Default waiting observes the caller's own `pi.inbox`: an already queued item
 * wakes immediately, and newly admitted activity wakes a subscribed watch.
 * Optional targets additionally wait for their current ordinary work to settle.
 * The absolute deadline is stored in a durable task memo, so a restart resumes
 * the same deadline instead of resetting it.
 *
 * Every observation runs on a derived context that the timeout or the
 * invocation can cancel, so a timeout cancels only those waits. The deadline
 * timer and the parent abort listener are always cleared in `finally`.
 */

import { withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { InboxDoc, type InboxState } from '@earendil-works/pi-durable'
import type {
    ConversationHandle,
    Cursor,
    DocumentWatch,
    TaskId,
    ToolExecutionApi,
} from '@earendil-works/pi-durable'
import { isRootPath, resolveTarget } from '../domain/agent-path.js'
import { clampWaitTimeout } from '../config/config.js'
import { callerInfo, requireAgent, type RuntimeDeps } from './context.js'

export interface WaitArgs {
    readonly timeout_ms?: number
    readonly targets?: readonly string[]
}

export type WaitDetails = {
    readonly message: string
    readonly timed_out: boolean
}

const DEADLINE_MEMO = 'wait:deadline'

type WaitOutcome =
    | { readonly kind: 'activity' }
    | { readonly kind: 'target' }
    | { readonly kind: 'timeout' }
    | { readonly kind: 'cancelled' }

export async function waitAgent(
    deps: RuntimeDeps,
    api: ToolExecutionApi,
    args: WaitArgs,
    context: Context
): Promise<WaitDetails> {
    const caller = await callerInfo(api, context)
    const clamped = clampWaitTimeout(deps.config, args.timeout_ms)
    if (clamped.rejected !== undefined) throw new Error(clamped.rejected)
    const note = clamped.note

    const deadline = await api.memo<number>(
        DEADLINE_MEMO,
        Date.now() + clamped.effectiveMs,
        context
    )

    const observed: ConversationHandle[] = []
    for (const requested of args.targets ?? []) {
        const path = resolveTarget(caller.path, requested)
        if (isRootPath(path)) {
            throw new Error('wait_agent cannot wait on the root agent.')
        }
        if (path === caller.path) {
            throw new Error('wait_agent cannot wait on its own conversation.')
        }
        const agent = await requireAgent(api, context, path)
        const handle = await api.conversation(agent.conversationId, context)
        if (handle === undefined) {
            throw new Error(`Conversation ${agent.conversationId} is missing.`)
        }
        observed.push(handle)
    }

    // A child identity and its reporter intent are committed before the
    // reporter submits the initial input. Waiting only on child idle would
    // return in that gap, so wait on the existing reporter tasks too.
    const targets = await Promise.all(
        observed.map(async (handle) => ({
            handle,
            reporterIds: await pendingReporterIds(api, context, handle.id),
        }))
    )

    const cancel = new AbortController()
    const waitContext = withAbortSignal(cancel.signal, context)
    if (context.abortSignal?.aborted === true) cancel.abort()
    const onParentAbort = () => cancel.abort()
    context.abortSignal?.addEventListener('abort', onParentAbort, {
        once: true,
    })
    const timer = createDeadline(deadline)
    let watch: DocumentWatch<InboxState> | undefined
    try {
        watch = await api.watchDoc(InboxDoc, caller.conversationId, waitContext)
        if (watch === undefined) {
            throw new Error('The built-in inbox document is unavailable.')
        }
        if (hasInboxItems(watch)) return detail('Wait completed.', note, false)
        const outcome = await Promise.race<WaitOutcome>([
            inboxWake(watch),
            ...targets.map((target) =>
                Promise.all(
                    target.reporterIds.map((id) =>
                        api.waitForTask(id, waitContext)
                    )
                )
                    .then(() => target.handle.waitForIdle(waitContext))
                    .then<WaitOutcome>(() => ({ kind: 'target' }))
                    .catch<WaitOutcome>(() => ({ kind: 'cancelled' }))
            ),
            timer.promise,
            abortWake(cancel.signal),
        ])
        if (outcome.kind === 'cancelled') throw new Error('Wait cancelled.')
        if (outcome.kind === 'timeout') {
            return detail('Wait timed out.', note, true)
        }
        return detail('Wait completed.', note, false)
    } finally {
        timer.cancel()
        cancel.abort()
        context.abortSignal?.removeEventListener('abort', onParentAbort)
        await watch?.stop()
    }
}

function detail(
    message: string,
    note: string | undefined,
    timedOut: boolean
): WaitDetails {
    return {
        message: note === undefined ? message : `${message} ${note}`,
        timed_out: timedOut,
    }
}

function hasInboxItems(watch: DocumentWatch<InboxState>): boolean {
    return (watch.value?.items.length ?? 0) > 0
}

/** Live reporter task IDs targeting one child conversation. */
async function pendingReporterIds(
    api: ToolExecutionApi,
    context: Context,
    childId: number
): Promise<TaskId[]> {
    return api.commit(async (tx) => {
        const ids: TaskId[] = []
        let cursor: Cursor | undefined
        for (;;) {
            const page = await tx.scanTasks(
                { kind: 'subagents.reporter' },
                128,
                cursor
            )
            for (const record of page.items) {
                if (record.state.status === 'terminal') continue
                const input = record.input as { readonly childId?: unknown }
                if (input.childId === childId) ids.push(record.id)
            }
            if (page.next === undefined) return ids
            cursor = page.next
        }
    }, context)
}

function inboxWake(watch: DocumentWatch<InboxState>): Promise<WaitOutcome> {
    if (hasInboxItems(watch)) return Promise.resolve({ kind: 'activity' })
    return new Promise<WaitOutcome>((resolve) => {
        watch.start(async (value) => {
            if ((value?.items.length ?? 0) > 0) resolve({ kind: 'activity' })
        })
    })
}

function createDeadline(deadline: number): {
    readonly promise: Promise<WaitOutcome>
    cancel(): void
} {
    const remaining = Math.max(0, deadline - Date.now())
    let handle: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<WaitOutcome>((resolve) => {
        handle = setTimeout(() => resolve({ kind: 'timeout' }), remaining)
    })
    return {
        promise,
        cancel: () => {
            if (handle !== undefined) {
                clearTimeout(handle)
                handle = undefined
            }
        },
    }
}

function abortWake(signal: AbortSignal): Promise<WaitOutcome> {
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' })
    return new Promise<WaitOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), {
            once: true,
        })
    })
}
