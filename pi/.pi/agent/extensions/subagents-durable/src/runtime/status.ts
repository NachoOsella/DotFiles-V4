/**
 * Native terminal status from own generation task receipts.
 *
 * Status comes from the newest `pi.generation` task the conversation owns,
 * never from assistant history. A generation that aborts before committing any
 * partial, or fails before a model is available, still writes a terminal task
 * outcome, so status cannot go stale; passive writes cannot hide it. A native
 * fork owns no generation tasks, so it never inherits a parent status.
 *
 * `Tx.scanTasks` returns ascending IDs, so this helper pages through every
 * generation task of a conversation and keeps the newest, plus the newest
 * completed one for an answer preview. Cost is O(generation tasks) per status
 * read; callers batch conversations into one scan.
 */

import type {
    ConversationId,
    Cursor,
    EntryId,
    TaskOutcome,
    TaskRecord,
    Tx,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { GenerationTask } from '@earendil-works/pi-durable'

export type OwnGenerationStatus = 'Completed' | 'Errored' | 'Interrupted'

export type OwnGenerationInfo = {
    /** Terminal status of the newest generation task; absent while it is live. */
    readonly status?: OwnGenerationStatus
    /** Assistant entry of the newest completed generation, when one exists. */
    readonly answerEntryId?: EntryId
}

const GENERATION_KIND = GenerationTask.definition.name
const PAGE_SIZE = 256

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>

/**
 * Newest own generation receipt per conversation. Conversations without any
 * generation task (for example a fresh fork) are absent.
 */
export async function ownGenerationStatuses(
    tx: Tx,
    conversationIds: readonly ConversationId[]
): Promise<Map<ConversationId, OwnGenerationInfo>> {
    const statuses = new Map<ConversationId, OwnGenerationInfo>()
    for (const conversationId of conversationIds) {
        let newest: AnyTaskRecord | undefined
        let newestCompleted: AnyTaskRecord | undefined
        let cursor: Cursor | undefined
        do {
            const page = await tx.scanTasks(
                { conversationId, kind: GENERATION_KIND },
                PAGE_SIZE,
                cursor
            )
            for (const record of page.items) {
                newest = record
                if (isCompleted(record)) newestCompleted = record
            }
            cursor = page.next
        } while (cursor !== undefined)
        if (newest === undefined) continue
        const status = statusOf(newest)
        const answerEntryId =
            newestCompleted === undefined
                ? undefined
                : answerEntryIdOf(newestCompleted)
        statuses.set(conversationId, {
            ...(status === undefined ? {} : { status }),
            ...(answerEntryId === undefined ? {} : { answerEntryId }),
        })
    }
    return statuses
}

function statusOf(record: AnyTaskRecord): OwnGenerationStatus | undefined {
    const state = record.state
    if (state.status !== 'terminal') return undefined
    return mapOutcome(state.outcome)
}

function mapOutcome(outcome: TaskOutcome<JsonValue>): OwnGenerationStatus {
    switch (outcome.status) {
        case 'completed':
            return 'Completed'
        case 'failed':
        case 'faulted':
        case 'orphaned':
            return 'Errored'
        case 'aborted':
            return 'Interrupted'
    }
}

function isCompleted(record: AnyTaskRecord): boolean {
    return (
        record.state.status === 'terminal' &&
        record.state.outcome.status === 'completed'
    )
}

function answerEntryIdOf(record: AnyTaskRecord): EntryId | undefined {
    const state = record.state
    if (state.status !== 'terminal' || state.outcome.status !== 'completed')
        return undefined
    return (state.outcome.result as { readonly entryId?: EntryId }).entryId
}
