import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ExecutionLimiter } from './src/execution-limiter.ts'
import { projectFork } from './src/fork-projector.ts'
import { parseForkTurns } from './src/communication.ts'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { WaitHub } from './src/wait-hub.ts'

function assistant(text: string, stopReason: 'stop' | 'toolUse' = 'stop') {
    return {
        role: 'assistant',
        content:
            stopReason === 'stop'
                ? [{ type: 'text', text }]
                : [
                      {
                          type: 'toolCall',
                          id: 'call-1',
                          name: 'bash',
                          arguments: '{}',
                      },
                  ],
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
    }
}

describe('V3 execution limiter', () => {
    it('limits runs and releases each permit exactly once', () => {
        const limiter = new ExecutionLimiter(1)
        const permit = limiter.tryAcquire()
        assert.equal(limiter.active, 1)
        assert.throws(() => limiter.tryAcquire(), /active slots/)
        permit.release()
        permit.release()
        assert.equal(limiter.active, 0)
        const next = limiter.tryAcquire()
        assert.ok(next.sequence > permit.sequence)
    })
})

describe('V3 wait hub', () => {
    it('does not consume content and closes the lost-wakeup window', async () => {
        const hub = new WaitHub()
        hub.notifyMailbox('/root')
        const pending = await hub.wait('/root', 10)
        assert.deepEqual(pending, { kind: 'mailbox', timedOut: false })
        assert.equal(hub.hasPending('/root'), false)

        const future = hub.wait('/root', 100)
        hub.notifySteer('/root')
        assert.deepEqual(await future, { kind: 'steer', timedOut: false })
        assert.equal(hub.hasPending('/root'), false)
    })
})

describe('V3 Pi session persistence characterization', () => {
    it('reopens a nested persistent session with custom communication', async () => {
        const root = await mkdtemp(join(tmpdir(), 'subagents-v3-'))
        const sessions = join(root, '.subagents', 'root-session')
        try {
            const created = SessionManager.create('/repo', sessions)
            created.appendCustomMessageEntry(
                'subagents-v3:communication',
                'Message Type: MESSAGE\\nPayload: kiwi-927',
                false,
                { marker: 'kiwi-927' }
            )
            created.appendMessage(assistant('persisted answer') as never)
            const reopened = SessionManager.open(
                created.getSessionFile()!,
                sessions,
                '/repo'
            )
            const [entry] = reopened.buildContextEntries()
            assert.equal(entry?.type, 'custom_message')
            assert.equal(
                entry?.type === 'custom_message' ? entry.content : undefined,
                'Message Type: MESSAGE\\nPayload: kiwi-927'
            )
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

describe('V3 structured fork projector', () => {
    it('keeps structured final turns and drops tool chatter and communication', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendMessage({
            role: 'user',
            content: 'turn one',
            timestamp: Date.now(),
        })
        session.appendMessage(assistant('answer one') as never)
        session.appendMessage(assistant('tool call', 'toolUse') as never)
        session.appendMessage({
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'output' }],
            isError: false,
            timestamp: Date.now(),
        } as never)
        session.appendCustomMessageEntry(
            'subagents-v3:communication',
            'Message Type: FINAL_ANSWER',
            false,
            {}
        )
        session.appendMessage({
            role: 'user',
            content: 'turn two',
            timestamp: Date.now(),
        })
        session.appendMessage(assistant('answer two') as never)

        const all = projectFork(
            session.buildContextEntries(),
            parseForkTurns('all')
        )
        assert.deepEqual(
            all.map((message) => message.role),
            ['user', 'assistant', 'user', 'assistant']
        )
        assert.equal(
            all[1]?.role === 'assistant' ? all[1].content.length : 0,
            1
        )
        assert.equal(
            all[3]?.role === 'assistant' ? all[3].content[0]?.type : undefined,
            'text'
        )

        const last = projectFork(
            session.buildContextEntries(),
            parseForkTurns('1')
        )
        assert.deepEqual(
            last.map((message) =>
                message.role === 'user'
                    ? message.content
                    : message.role === 'assistant'
                      ? message.content[0]?.type
                      : message.role
            ),
            ['turn two', 'text']
        )
    })
})
