import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import type { AgentPath } from '../domain/ids.ts'
import { INHERITED_TASK_CUSTOM_TYPE } from '../persistence/fork-projector.ts'
import { SessionFactory } from './session-factory.ts'

const MODEL: Model<'test-api'> = {
    id: 'test-model',
    name: 'Test model',
    api: 'test-api',
    provider: 'test-provider',
    baseUrl: 'http://test.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
}

const COMMUNICATION_TYPE = 'subagents-v3:communication'

function assistant(text: string): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
                input: 0.1,
                output: 0.2,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.3,
            },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
    }
}

function appendCommunication(
    session: SessionManager,
    messageType: 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER',
    payload: string,
    author = '/root',
    recipient = '/root/child'
): string {
    const envelope = [
        `Message Type: ${messageType}`,
        `Task name: ${recipient.split('/').at(-1)}`,
        `Sender: ${author}`,
        'Payload:',
        payload,
    ].join('\n')
    return session.appendCustomMessageEntry(
        COMMUNICATION_TYPE,
        envelope,
        false,
        {
            id: `comm-${Math.random().toString(16).slice(2)}`,
            kind: messageType === 'FINAL_ANSWER' ? 'result' : 'spawn',
            messageType,
            author,
            recipient,
            payload,
        }
    )
}

function record(path = '/root/child'): AgentRecord {
    return {
        id: 'agent-1' as AgentRecord['id'],
        path: path as AgentPath,
        parentId: 'root' as AgentRecord['id'],
        parentPath: '/root' as AgentPath,
        status: AgentStatus.pendingInit(),
        residency: 'loading',
        model: 'test-provider/test-model',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        activeTools: ['read'],
    }
}

function parent(entries: ParentExecutionSnapshot['contextEntries']) {
    return {
        path: '/root' as AgentPath,
        cwd: '/repo',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium',
        activeTools: ['read'],
        contextEntries: entries,
        sessionId: 'root-session',
    } satisfies ParentExecutionSnapshot
}

function createFactory(rootSessionDir = '') {
    return new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => rootSessionDir,
        agentDir: mkdtempSync(join(tmpdir(), 'subagents-context-agent-')),
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        config: DEFAULT_SUBAGENTS_CONFIG,
    })
}

function contextMessages(session: SessionManager) {
    return session.buildSessionContext().messages
}

test('LastN(1) selects one logical child turn including its task provenance', async () => {
    const parentSession = SessionManager.inMemory('/repo')
    for (const [task, answer] of [
        ['first task', 'first answer'],
        ['second task', 'second answer'],
        ['third task', 'third answer'],
    ]) {
        appendCommunication(parentSession, 'NEW_TASK', task)
        parentSession.appendMessage(assistant(answer) as never)
    }

    const factory = createFactory()
    const runtime = await factory.create(
        record(),
        parent(parentSession.getBranch()),
        { _tag: 'LastN', turns: 1 }
    )
    try {
        const messages = contextMessages(runtime.session.sessionManager)
        const serialized = JSON.stringify(messages)
        assert.match(serialized, /third task/)
        assert.match(serialized, /third answer/)
        assert.doesNotMatch(serialized, /first answer/)
        assert.doesNotMatch(serialized, /second answer/)

        const inherited = messages.find(
            (message) =>
                message.role === 'custom' &&
                message.customType === INHERITED_TASK_CUSTOM_TYPE
        )
        assert.ok(inherited)
        assert.match(
            inherited.role === 'custom' ? String(inherited.content) : '',
            /Inherited task context. This is not a new instruction./
        )
        assert.match(
            inherited.role === 'custom' ? String(inherited.content) : '',
            /Sender: \/root/
        )
        assert.ok(
            messages.every(
                (message) =>
                    !(
                        message.role === 'custom' &&
                        String(message.content).startsWith('Message Type:')
                    )
            ),
            'control envelopes must not be replayed as fresh assignments'
        )
        assert.equal(
            messages.filter((message) => message.role === 'assistant').length,
            1
        )
    } finally {
        await runtime.dispose()
    }
})

test('a nested FINAL_ANSWER starts its own logical input group', async () => {
    const parentSession = SessionManager.inMemory('/repo')
    appendCommunication(parentSession, 'NEW_TASK', 'alpha task')
    parentSession.appendMessage(assistant('alpha answer') as never)
    appendCommunication(
        parentSession,
        'FINAL_ANSWER',
        'nested result',
        '/root/child/grand'
    )
    parentSession.appendMessage(assistant('after nested result') as never)
    appendCommunication(parentSession, 'NEW_TASK', 'beta task')
    parentSession.appendMessage(assistant('beta answer') as never)
    const entries = parentSession.getBranch()

    const factory = createFactory()
    const last = await factory.create(record(), parent(entries), {
        _tag: 'LastN',
        turns: 1,
    })
    try {
        const serialized = JSON.stringify(
            contextMessages(last.session.sessionManager)
        )
        assert.match(serialized, /beta task/)
        assert.match(serialized, /beta answer/)
        assert.doesNotMatch(serialized, /nested result/)
        assert.doesNotMatch(serialized, /alpha answer/)
    } finally {
        await last.dispose()
    }

    const two = await factory.create(record(), parent(entries), {
        _tag: 'LastN',
        turns: 2,
    })
    try {
        const serialized = JSON.stringify(
            contextMessages(two.session.sessionManager)
        )
        assert.match(serialized, /nested result/)
        assert.match(serialized, /after nested result/)
        assert.match(serialized, /beta answer/)
        assert.doesNotMatch(serialized, /alpha answer/)
    } finally {
        await two.dispose()
    }
})

test('compacted parent keeps context through reopen and later compaction', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-compaction-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const parentSession = SessionManager.inMemory('/repo')
    parentSession.appendMessage({
        role: 'user',
        content: 'old question',
        timestamp: Date.now(),
    } as never)
    parentSession.appendMessage(assistant('old answer') as never)
    const retainedId = parentSession.appendMessage({
        role: 'user',
        content: 'retained question',
        timestamp: Date.now(),
    } as never)
    parentSession.appendMessage(assistant('retained answer') as never)
    parentSession.appendCompaction('Parent summary', retainedId, 500)
    parentSession.appendMessage({
        role: 'user',
        content: 'after compaction question',
        timestamp: Date.now(),
    } as never)
    parentSession.appendMessage(assistant('after compaction answer') as never)

    const factory = createFactory(root)
    const child = record()
    const runtime = await factory.create(
        child,
        parent(parentSession.getBranch()),
        { _tag: 'All' }
    )
    let sessionFile: string
    try {
        const manager = runtime.session.sessionManager
        assert.match(JSON.stringify(contextMessages(manager)), /Parent summary/)
        assert.match(
            JSON.stringify(contextMessages(manager)),
            /retained answer/
        )
        assert.match(
            JSON.stringify(contextMessages(manager)),
            /after compaction answer/
        )
        assert.doesNotMatch(
            JSON.stringify(contextMessages(manager)),
            /old answer/
        )
        assert.equal(runtime.session.getSessionStats().cost, 0)

        const compaction = manager
            .getEntries()
            .find((entry) => entry.type === 'compaction')
        assert.ok(compaction, 'inherited compaction must be a top-level entry')
        assert.notEqual(compaction.firstKeptEntryId, retainedId)
        assert.ok(
            manager
                .getEntries()
                .some((entry) => entry.id === compaction.firstKeptEntryId),
            'firstKeptEntryId must reference a child entry'
        )

        manager.appendMessage({
            role: 'user',
            content: 'child question',
            timestamp: Date.now(),
        } as never)
        sessionFile = runtime.session.sessionFile!
    } finally {
        await runtime.dispose()
    }

    const reopened = await factory.open({ ...child, sessionFile })
    try {
        const manager = reopened.session.sessionManager
        assert.match(JSON.stringify(contextMessages(manager)), /Parent summary/)
        assert.match(
            JSON.stringify(contextMessages(manager)),
            /retained answer/
        )
        assert.match(
            JSON.stringify(contextMessages(manager)),
            /after compaction answer/
        )
        assert.equal(reopened.session.getSessionStats().cost, 0)

        const previous = manager
            .getEntries()
            .find((entry) => entry.type === 'compaction')
        assert.ok(previous)
        manager.appendMessage({
            role: 'user',
            content: 'later question',
            timestamp: Date.now(),
        } as never)
        manager.appendMessage(assistant('later answer') as never)
        manager.appendCompaction(
            'Second summary',
            previous.firstKeptEntryId,
            900
        )
        const after = JSON.stringify(contextMessages(manager))
        assert.match(after, /Second summary/)
        assert.match(after, /retained answer/)
        assert.match(after, /after compaction answer/)
        assert.match(after, /later answer/)
        assert.doesNotMatch(after, /old answer/)
    } finally {
        await reopened.dispose()
    }
})

test('branch summaries import with child entry references', async () => {
    const parentSession = SessionManager.inMemory('/repo')
    const startId = parentSession.appendMessage({
        role: 'user',
        content: 'root question',
        timestamp: Date.now(),
    } as never)
    parentSession.appendMessage(assistant('abandoned answer') as never)
    parentSession.branch(startId)
    parentSession.branchWithSummary(
        startId,
        'Abandoned branch summary',
        undefined,
        false
    )

    const factory = createFactory()
    const runtime = await factory.create(
        record(),
        parent(parentSession.getBranch()),
        { _tag: 'All' }
    )
    try {
        const manager = runtime.session.sessionManager
        assert.match(
            JSON.stringify(contextMessages(manager)),
            /Abandoned branch summary/
        )
        const summary = manager
            .getEntries()
            .find((entry) => entry.type === 'branch_summary')
        assert.ok(summary, 'branch summary must be a top-level entry')
        assert.ok(
            manager.getEntries().some((entry) => entry.id === summary.fromId),
            'branch summary must point at a child entry'
        )
        assert.doesNotMatch(
            JSON.stringify(contextMessages(manager)),
            /abandoned answer/
        )
    } finally {
        await runtime.dispose()
    }
})
