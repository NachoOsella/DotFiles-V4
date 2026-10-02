import assert from 'node:assert/strict'
import test from 'node:test'
import {
    InvalidForkTurnsError,
    displayNameFor,
    formatEnvelope,
    parseForkTurns,
} from '../src/domain/communication.js'

test('parseForkTurns defaults to the full history', () => {
    assert.deepEqual(parseForkTurns(), { kind: 'all' })
    assert.deepEqual(parseForkTurns(''), { kind: 'all' })
    assert.deepEqual(parseForkTurns('all'), { kind: 'all' })
    assert.deepEqual(parseForkTurns('ALL'), { kind: 'all' })
})

test('parseForkTurns recognizes none and positive integers', () => {
    assert.deepEqual(parseForkTurns('none'), { kind: 'none' })
    assert.deepEqual(parseForkTurns('2'), { kind: 'recent', turns: 2 })
})

test('parseForkTurns rejects zero and unrecognized values', () => {
    assert.throws(() => parseForkTurns('0'), InvalidForkTurnsError)
    assert.throws(() => parseForkTurns('-1'), InvalidForkTurnsError)
    assert.throws(() => parseForkTurns('1.5'), InvalidForkTurnsError)
    assert.throws(() => parseForkTurns('latest'), InvalidForkTurnsError)
})

test('formatEnvelope renders the canonical four-line envelope', () => {
    assert.equal(
        formatEnvelope('NEW_TASK', 'worker', '/root', 'Do the thing.'),
        'Message Type: NEW_TASK\nTask name: worker\nSender: /root\nPayload:\nDo the thing.'
    )
})

test('displayNameFor returns the last segment or /root', () => {
    assert.equal(displayNameFor('/root'), '/root')
    assert.equal(displayNameFor('/root/a/b'), 'b')
})
