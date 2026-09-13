import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    assertNonEmptyMessage,
    displayNameFor,
    EmptyAgentMessageError,
    finalAnswerCommunication,
    InvalidForkTurnsError,
    newTaskCommunication,
    parseForkTurns,
    plainMessageCommunication,
    renderCommunicationText,
    renderEnvelope,
} from './src/communication.ts'
import { formatFinalAnswer } from './src/completion.ts'
import { AgentStatus } from './src/agent-status.ts'
import type { AgentPath } from './src/ids.ts'
import { rootEndpoint } from './src/transport.ts'

const ROOT = '/root' as AgentPath
const CHILD = '/root/worker' as AgentPath

describe('fork_turns parsing', () => {
    it('defaults omitted and blank to all', () => {
        assert.deepEqual(parseForkTurns(undefined), { _tag: 'All' })
        assert.deepEqual(parseForkTurns(''), { _tag: 'All' })
        assert.deepEqual(parseForkTurns('  '), { _tag: 'All' })
        assert.deepEqual(parseForkTurns('all'), { _tag: 'All' })
        assert.deepEqual(parseForkTurns('none'), { _tag: 'None' })
        assert.deepEqual(parseForkTurns('3'), { _tag: 'LastN', turns: 3 })
    })

    it('rejects zero and malformed values', () => {
        assert.throws(() => parseForkTurns('0'), InvalidForkTurnsError)
        assert.throws(() => parseForkTurns('-2'), InvalidForkTurnsError)
        assert.throws(() => parseForkTurns('recent'), InvalidForkTurnsError)
        assert.throws(
            () => assertNonEmptyMessage('   '),
            EmptyAgentMessageError
        )
    })
})

describe('communication envelopes', () => {
    it('renders the canonical NEW_TASK envelope', () => {
        const text = renderEnvelope('NEW_TASK', 'worker', '/root', 'do it')
        assert.equal(
            text,
            'Message Type: NEW_TASK\nTask name: worker\nSender: /root\nPayload:\ndo it'
        )
    })

    it('shows FINAL_ANSWER deliveries in the root transcript', async () => {
        const deliveries: Array<{
            message: { display: boolean; content: unknown }
            options: { triggerTurn: boolean }
        }> = []
        const endpoint = rootEndpoint(ROOT, (message, options) => {
            deliveries.push({ message, options })
        })
        await endpoint.send(
            finalAnswerCommunication({
                author: CHILD,
                recipient: ROOT,
                payload: 'done',
            }),
            { triggerTurn: false }
        )

        assert.equal(deliveries[0]?.message.display, true)
        assert.equal(deliveries[0]?.options.triggerTurn, false)
        assert.match(String(deliveries[0]?.message.content), /FINAL_ANSWER/)
        assert.match(
            String(deliveries[0]?.message.content),
            /Sender: \/root\/worker/
        )
        assert.match(String(deliveries[0]?.message.content), /Payload:\ndone/)
    })

    it('maps kinds to message types and trigger flags', () => {
        const spawn = newTaskCommunication({
            kind: 'spawn',
            author: ROOT,
            recipient: CHILD,
            payload: 'task',
        })
        assert.equal(spawn.messageType, 'NEW_TASK')
        assert.equal(spawn.triggerTurn, true)

        const followup = newTaskCommunication({
            kind: 'followup',
            author: ROOT,
            recipient: CHILD,
            payload: 'more',
        })
        assert.equal(followup.messageType, 'NEW_TASK')
        assert.equal(followup.triggerTurn, true)

        const message = plainMessageCommunication({
            author: CHILD,
            recipient: ROOT,
            payload: 'progress',
        })
        assert.equal(message.messageType, 'MESSAGE')
        assert.equal(message.triggerTurn, false)

        const answer = finalAnswerCommunication({
            author: CHILD,
            recipient: ROOT,
            payload: 'done',
        })
        assert.equal(answer.messageType, 'FINAL_ANSWER')
        assert.equal(answer.triggerTurn, false)

        assert.equal(displayNameFor(CHILD), 'worker')
        const rendered = renderCommunicationText(answer)
        assert.match(rendered, /Message Type: FINAL_ANSWER/)
    })
})

describe('completion formatting', () => {
    it('passes through success and empty success', () => {
        assert.equal(formatFinalAnswer(AgentStatus.completed('done')), 'done')
        assert.equal(formatFinalAnswer(AgentStatus.completed(null)), '')
    })

    it('bounds terminal errors with recovery guidance', () => {
        const long = `x`.repeat(10_000)
        const payload = formatFinalAnswer(AgentStatus.errored(long))!
        assert.match(payload, /^Agent errored: /)
        assert.match(payload, /followup_task/)
        assert.ok(payload.length < long.length)
    })

    it('produces no completion for non-terminal states', () => {
        assert.equal(formatFinalAnswer(AgentStatus.running()), null)
        assert.equal(formatFinalAnswer(AgentStatus.interrupted()), null)
        assert.equal(formatFinalAnswer(AgentStatus.pendingInit()), null)
    })
})
