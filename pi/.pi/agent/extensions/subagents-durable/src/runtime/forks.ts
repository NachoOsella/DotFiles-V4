/**
 * Native fork selection.
 *
 * Durable forks retain a prefix of the parent's history through an EntryId;
 * a recent-N request needs a suffix, which no single fork point can express.
 * The helper forks at the parent's current tail and adds native omission
 * edits for older logical turns. Native structured history inside selected
 * turns is retained; only omissions are added, never copied messages. Reads
 * run before the caller's first table write.
 *
 * A logical turn here matches the legacy grouping: a turn ends at a final
 * assistant response (`stop` or `length`). User inputs that arrive before a
 * final response, for example several steers, stay in the same turn. Effective
 * contributions honor the newest native context edit in the active range, so
 * an omitted or replaced input does not create a turn boundary.
 */

import type {
    ContextEdit,
    ConversationId,
    Cursor,
    EntryId,
    EntryRecord,
    Tx,
} from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { parseForkTurns } from '../domain/communication.js'

const SCAN_PAGE_SIZE = 256

export interface ForkSelection {
    /** Fork point, absent when the child starts without inherited history. */
    readonly at?: EntryId
    /** Context edits to attach to one child entry, oldest entries first. */
    readonly edits: ContextEdit[]
}

/**
 * Select how a child inherits its parent's conversation.
 *
 * - `none`: no fork point and no edits.
 * - an empty parent: no fork point and no edits.
 * - `all` (default): fork at the current tail with no edits.
 * - `recent N`: fork at the current tail and omit every active entry before
 *   the first entry of the Nth-from-last logical turn.
 */
export async function selectFork(
    tx: Tx,
    parentId: ConversationId,
    forkTurns?: string
): Promise<ForkSelection> {
    const fork = parseForkTurns(forkTurns)
    if (fork.kind === 'none') return { edits: [] }

    const tail = await latestVisibleEntryId(tx, parentId)
    if (tail === undefined) return { edits: [] }
    if (fork.kind === 'all') return { at: tail, edits: [] }

    const head = await tx.latestHeadMarker(parentId)
    const range = await scanRange(tx, parentId, head, tail)
    const edits = collectEdits(range)
    // Head markers are the active baseline and never counted as turns.
    const active = range.filter((entry) => entry.head === undefined)
    const groups = groupTurns(active, edits)
    if (groups.length <= fork.turns) return { at: tail, edits: [] }

    const start = groups[groups.length - fork.turns]![0]!
    const omissions: ContextEdit[] = []
    for (const entry of active) {
        if (entry.id >= start.id) break
        omissions.push({ target: entry.id, action: 'omit' })
    }
    return { at: tail, edits: omissions }
}

async function latestVisibleEntryId(
    tx: Tx,
    parentId: ConversationId
): Promise<EntryId | undefined> {
    const page = await tx.scanEntries({ conversationId: parentId }, 1)
    return page.items[0]?.id
}

/** Active range, oldest first, including the newest head marker. */
async function scanRange(
    tx: Tx,
    parentId: ConversationId,
    head: (EntryRecord & { readonly head: EntryId }) | undefined,
    tail: EntryId
): Promise<EntryRecord[]> {
    const query =
        head === undefined
            ? { conversationId: parentId, maxEntryId: tail }
            : {
                  conversationId: parentId,
                  minEntryId: head.head,
                  maxEntryId: tail,
              }
    const entries: EntryRecord[] = []
    let cursor: Cursor | undefined
    do {
        const page = await tx.scanEntries(query, SCAN_PAGE_SIZE, cursor)
        entries.push(...page.items)
        cursor = page.next
    } while (cursor !== undefined)
    return entries.reverse()
}

/** Newest context edit per target, exactly as Durable's context derivation. */
function collectEdits(
    range: readonly EntryRecord[]
): Map<EntryId, ContextEdit> {
    const edits = new Map<EntryId, ContextEdit>()
    for (const entry of range) {
        for (const edit of entry.edits ?? []) edits.set(edit.target, edit)
    }
    return edits
}

function effectiveMessages(
    entry: EntryRecord,
    edits: ReadonlyMap<EntryId, ContextEdit>
): readonly Message[] {
    const edit = edits.get(entry.id)
    if (edit?.action === 'omit') return []
    if (edit?.action === 'replace') return edit.messages
    return entry.model ?? []
}

function isInput(
    entry: EntryRecord,
    edits: ReadonlyMap<EntryId, ContextEdit>
): boolean {
    return effectiveMessages(entry, edits).some(
        (message) => message.role === 'user'
    )
}

function isFinalAssistant(
    entry: EntryRecord,
    edits: ReadonlyMap<EntryId, ContextEdit>
): boolean {
    return effectiveMessages(entry, edits).some(
        (message) =>
            message.role === 'assistant' &&
            (message.stopReason === 'stop' || message.stopReason === 'length')
    )
}

function groupTurns(
    entries: readonly EntryRecord[],
    edits: ReadonlyMap<EntryId, ContextEdit>
): EntryRecord[][] {
    const groups: EntryRecord[][] = []
    let current: EntryRecord[] = []
    let hasFinal = false
    for (const entry of entries) {
        if (isInput(entry, edits) && current.length > 0 && hasFinal) {
            groups.push(current)
            current = []
            hasFinal = false
        }
        current.push(entry)
        if (isFinalAssistant(entry, edits)) hasFinal = true
    }
    if (current.length > 0) groups.push(current)
    return groups
}
