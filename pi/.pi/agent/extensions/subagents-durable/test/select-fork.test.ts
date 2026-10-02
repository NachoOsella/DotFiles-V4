import assert from 'node:assert/strict'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { MemoryStorage, createSession } from '@earendil-works/pi-durable'
import type {
    ContextEdit,
    ConversationId,
    EntryDraft,
    EntryRecord,
    Session,
} from '@earendil-works/pi-durable'
import type {
    AssistantMessage,
    Message,
    UserMessage,
} from '@earendil-works/pi-ai'
import { selectFork, type ForkSelection } from '../src/runtime/forks.js'

const context = BACKGROUND_CONTEXT
const session: Session = createSession(new MemoryStorage())

async function newConversation(): Promise<ConversationId> {
    const record = await session.commit(
        (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }),
        context
    )
    return record.id
}

function append(
    conversationId: ConversationId,
    value: EntryDraft
): Promise<EntryRecord> {
    return session.commit(
        (tx) => tx.appendEntry(conversationId, value) as Promise<EntryRecord>,
        context
    )
}

function user(text: string): UserMessage {
    return { role: 'user', content: text, timestamp: Date.now() }
}

function assistant(
    text: string,
    stopReason: AssistantMessage['stopReason'] = 'stop'
): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'openai-responses',
        provider: 'test',
        model: 'test-model',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason,
        timestamp: Date.now(),
    } as AssistantMessage
}

function readFork(
    conversationId: ConversationId,
    forkTurns?: string
): Promise<ForkSelection> {
    return session.commit(
        (tx) => selectFork(tx, conversationId, forkTurns),
        context
    )
}

function omit(...targets: EntryRecord[]): ContextEdit[] {
    return targets.map((entry) => ({ target: entry.id, action: 'omit' }))
}

async function addTurn(
    conversationId: ConversationId,
    text: string
): Promise<{ user: EntryRecord; assistant: EntryRecord }> {
    const userEntry = await append(conversationId, {
        kind: 'pi.user',
        model: [user(text)],
    })
    const assistantEntry = await append(conversationId, {
        kind: 'pi.assistant',
        model: [assistant(`${text} answer`)],
    })
    return { user: userEntry, assistant: assistantEntry }
}

test('none and an empty parent select no fork point', async () => {
    const empty = await newConversation()
    assert.deepEqual(await readFork(empty, 'none'), { edits: [] })
    assert.deepEqual(await readFork(empty), { edits: [] })
    assert.deepEqual(await readFork(empty, 'all'), { edits: [] })
})

test('all forks at the current tail with no edits', async () => {
    const conversation = await newConversation()
    await addTurn(conversation, 'one')
    const last = await addTurn(conversation, 'two')
    const selection = await readFork(conversation, 'all')
    assert.equal(selection.at, last.assistant.id)
    assert.deepEqual(selection.edits, [])
})

test('recent N omits whole logical turns before the Nth-from-last', async () => {
    const conversation = await newConversation()
    const first = await addTurn(conversation, 'one')
    const second = await addTurn(conversation, 'two')
    const third = await addTurn(conversation, 'three')

    const recentOne = await readFork(conversation, '1')
    assert.equal(recentOne.at, third.assistant.id)
    assert.deepEqual(
        recentOne.edits.map((edit) => edit.target),
        [first.user.id, first.assistant.id, second.user.id, second.assistant.id]
    )
    assert.ok(recentOne.edits.every((edit) => edit.action === 'omit'))

    const recentTwo = await readFork(conversation, '2')
    assert.deepEqual(
        recentTwo.edits.map((edit) => edit.target),
        [first.user.id, first.assistant.id]
    )
})

test('recent N keeps every active entry when fewer turns exist', async () => {
    const conversation = await newConversation()
    await addTurn(conversation, 'one')
    await addTurn(conversation, 'two')
    assert.deepEqual((await readFork(conversation, '5')).edits, [])
})

test('steering inputs before one final answer are one logical turn', async () => {
    const conversation = await newConversation()
    const first = await append(conversation, {
        kind: 'pi.user',
        model: [user('start')],
    })
    const steer = await append(conversation, {
        kind: 'pi.user',
        model: [user('also do this')],
    })
    const final = await append(conversation, {
        kind: 'pi.assistant',
        model: [assistant('combined answer')],
    })
    const next = await addTurn(conversation, 'next')

    assert.deepEqual((await readFork(conversation, '2')).edits, [])
    const selection = await readFork(conversation, '1')
    assert.deepEqual(
        selection.edits.map((edit) => edit.target),
        [first.id, steer.id, final.id]
    )
    assert.ok(!selection.edits.some((edit) => edit.target === next.user.id))
})

test('a non-final assistant does not complete a logical turn', async () => {
    const conversation = await newConversation()
    await append(conversation, {
        kind: 'pi.user',
        model: [user('start')],
    })
    await append(conversation, {
        kind: 'pi.assistant',
        model: [assistant('calling a tool', 'toolUse')],
    })
    await append(conversation, {
        kind: 'pi.user',
        model: [user('steer')],
    })
    const final = await append(conversation, {
        kind: 'pi.assistant',
        model: [assistant('done')],
    })
    const selection = await readFork(conversation, '1')
    // Only one logical turn exists, so nothing is omitted.
    assert.equal(selection.at, final.id)
    assert.deepEqual(selection.edits, [])
})

test('a prior omission of an input removes its turn boundary', async () => {
    const conversation = await newConversation()
    await addTurn(conversation, 'one')
    const second = await addTurn(conversation, 'two')
    await append(conversation, {
        kind: 'subagents.fork-cut',
        edits: omit(second.user),
    })

    // Without the omission this would be two turns and recent 1 would omit
    // the first turn. The omitted input collapses it to one turn.
    assert.deepEqual((await readFork(conversation, '1')).edits, [])
    const control = await newConversation()
    const controlFirst = await addTurn(control, 'one')
    await addTurn(control, 'two')
    assert.deepEqual(
        (await readFork(control, '1')).edits.map((edit) => edit.target),
        [controlFirst.user.id, controlFirst.assistant.id]
    )
})

test('a prior replacement that removes an input removes its turn boundary', async () => {
    const conversation = await newConversation()
    await addTurn(conversation, 'one')
    const second = await addTurn(conversation, 'two')
    await append(conversation, {
        kind: 'subagents.fork-cut',
        edits: [
            {
                target: second.user.id,
                action: 'replace',
                messages: [
                    {
                        role: 'system',
                        content: 'replaced input',
                        timestamp: Date.now(),
                    } as Message,
                ],
            },
        ],
    })
    assert.deepEqual((await readFork(conversation, '1')).edits, [])
})

test('recent N retains the active compaction baseline', async () => {
    const conversation = await newConversation()
    const first = await addTurn(conversation, 'old one')
    const kept = await addTurn(conversation, 'kept two')
    const compaction = await append(conversation, {
        kind: 'pi.compaction',
        head: kept.user.id,
        model: [user('Summary of earlier work.')],
        data: { reason: 'manual' },
    })
    const latest = await addTurn(conversation, 'latest three')

    const selection = await readFork(conversation, '1')
    assert.equal(selection.at, latest.assistant.id)
    assert.deepEqual(
        selection.edits.map((edit) => edit.target),
        [kept.user.id, kept.assistant.id]
    )
    assert.ok(!selection.edits.some((edit) => edit.target === compaction.id))
    assert.ok(!selection.edits.some((edit) => edit.target === first.user.id))
})

test('tool results do not count as turn boundaries', async () => {
    const conversation = await newConversation()
    const first = await addTurn(conversation, 'one')
    const toolResult: Message = {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: Date.now(),
    }
    const toolEntry = await append(conversation, {
        kind: 'pi.tool-result',
        model: [toolResult],
    })
    const second = await addTurn(conversation, 'two')

    assert.deepEqual((await readFork(conversation, '2')).edits, [])
    const selection = await readFork(conversation, '1')
    assert.equal(selection.at, second.assistant.id)
    assert.deepEqual(
        selection.edits.map((edit) => edit.target),
        [first.user.id, first.assistant.id, toolEntry.id]
    )
})
