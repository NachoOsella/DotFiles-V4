import assert from 'node:assert/strict'
import test from 'node:test'
import { Cause, Effect, Exit } from 'effect'
import { createAgentMailbox } from './src/mailbox.ts'

function message(
    text: string,
    overrides: Partial<{
        agentId: string
        taskName: string
        role: string
        kind: 'question' | 'result' | 'error' | 'cancelled'
        deduplicationKey: string
    }> = {}
) {
    return {
        agentId: 'sa-1',
        taskName: 'mailbox-test',
        role: 'worker',
        kind: 'result' as const,
        text,
        createdAt: 1,
        ...overrides,
    }
}

test('mailbox sequences messages and delivers each only once', () => {
    const mailbox = createAgentMailbox()
    const first = mailbox.publish(message('first'))
    const second = mailbox.publish(message('second'))

    assert.deepEqual(mailbox.drain(), [
        { ...first, sequence: 1 },
        { ...second, sequence: 2 },
    ])
    assert.deepEqual(mailbox.drain(), [])

    mailbox.publish(message('third'))
    mailbox.consume([3])
    assert.deepEqual(mailbox.drain(), [])
})

test('mailbox bounds retained events and text and deduplicates stable keys', () => {
    const mailbox = createAgentMailbox({ maxEvents: 2, maxTextBytes: 4 })

    assert.equal(
        mailbox.publish(message('ab', { deduplicationKey: 'one' }))?.sequence,
        1
    )
    assert.equal(
        mailbox.publish(message('cd', { deduplicationKey: 'two' }))?.sequence,
        2
    )
    assert.equal(
        mailbox.publish(message('ef', { deduplicationKey: 'three' }))?.sequence,
        3
    )
    assert.equal(
        mailbox.publish(message('repeat', { deduplicationKey: 'three' })),
        undefined
    )

    assert.equal(mailbox.size, 2)
    assert.equal(mailbox.retainedTextBytes, 4)
    assert.deepEqual(
        mailbox.drain().map((envelope) => [envelope.sequence, envelope.text]),
        [
            [2, 'cd'],
            [3, 'ef'],
        ]
    )

    const truncatingMailbox = createAgentMailbox({ maxTextBytes: 4 })
    assert.equal(truncatingMailbox.publish(message('abcdef'))?.text, 'abcd')
})

test('drain can consume selected agents without stealing other results', () => {
    const mailbox = createAgentMailbox()
    mailbox.publish(message('first', { agentId: 'sa-1' }))
    mailbox.publish(message('second', { agentId: 'sa-2' }))

    assert.deepEqual(
        mailbox.drain({ agentIds: ['sa-2'] }).map((event) => event.text),
        ['second']
    )
    assert.deepEqual(
        mailbox.drain().map((event) => event.text),
        ['first']
    )
})

test('wait returns matching messages and consumes them before automatic draining', async () => {
    const mailbox = createAgentMailbox()
    mailbox.publish(message('before'))

    const waiting = Effect.runPromise(
        mailbox.wait({ afterSequence: 1, timeoutMs: 100 })
    )
    queueMicrotask(() => {
        mailbox.publish(message('after'))
    })

    assert.deepEqual(await waiting, {
        events: [
            {
                sequence: 2,
                agentId: 'sa-1',
                taskName: 'mailbox-test',
                role: 'worker',
                kind: 'result',
                text: 'after',
                createdAt: 1,
            },
        ],
        nextSequence: 2,
        timedOut: false,
    })
    assert.deepEqual(mailbox.drain(), [
        {
            sequence: 1,
            agentId: 'sa-1',
            taskName: 'mailbox-test',
            role: 'worker',
            kind: 'result',
            text: 'before',
            createdAt: 1,
        },
    ])
})

test('wait times out without consuming later messages', async () => {
    const mailbox = createAgentMailbox()
    const result = await Effect.runPromise(mailbox.wait({ timeoutMs: 0 }))

    assert.deepEqual(result, { events: [], nextSequence: 0, timedOut: true })
    mailbox.publish(message('later'))
    assert.equal(mailbox.drain()[0]?.text, 'later')
})

test('closing wakes waits without consuming queued messages', async () => {
    const mailbox = createAgentMailbox()
    mailbox.publish(message('queued'))
    mailbox.close()

    assert.deepEqual(await Effect.runPromise(mailbox.wait()), {
        events: [],
        nextSequence: 0,
        timedOut: false,
    })
    assert.equal(mailbox.drain()[0]?.text, 'queued')
})

test('an interrupted wait leaves queued messages untouched', async () => {
    const mailbox = createAgentMailbox()
    const controller = new AbortController()
    const waiting = Effect.runPromiseExit(mailbox.wait(), {
        signal: controller.signal,
    })

    controller.abort()
    const exit = await waiting
    assert.ok(Exit.isFailure(exit))
    assert.ok(Cause.hasInterruptsOnly(exit.cause))

    mailbox.publish(message('after interruption'))
    assert.equal(mailbox.drain()[0]?.text, 'after interruption')
})
