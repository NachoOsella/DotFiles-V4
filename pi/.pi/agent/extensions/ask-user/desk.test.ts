import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeskPayload, isPiDesk, parseDeskReply } from './desk.ts'

const questions = [
    { question: 'Jitter?', options: [{ label: 'Full', description: 'best spread' }, { label: 'None' }] },
    { question: 'Timeout?', options: [{ label: '25s' }, { label: '60s' }] },
]

test('only active under pi-desk', () => {
    assert.equal(isPiDesk({ PI_DESK: '1' }), true)
    assert.equal(isPiDesk({}), false)
})

test('payload carries every question with ids and option values', () => {
    const payload = JSON.parse(buildDeskPayload(questions))
    assert.equal(payload.v, 1)
    assert.equal(payload.questions.length, 2)
    assert.deepEqual(payload.questions[0].options[0], { value: '1', label: 'Full', description: 'best spread' })
    assert.equal(payload.questions[1].id, 'q2')
})

test('parses selected and custom answers into StoredAnswer', () => {
    const result = parseDeskReply(
        JSON.stringify({ answers: [{ id: 'q1', value: '1' }, { id: 'q2', custom: true, label: ' 45s ' }] }),
        questions
    )
    assert.deepEqual(result, {
        kind: 'answered',
        answers: [
            { question: 'Jitter?', answer: 'Full', wasCustom: false, index: 1 },
            { question: 'Timeout?', answer: '45s', wasCustom: true },
        ],
    })
})

test('dismissal and garbage are distinguished', () => {
    assert.deepEqual(parseDeskReply(undefined, questions), { kind: 'dismissed' })
    assert.deepEqual(parseDeskReply('{"dismissed":true}', questions), { kind: 'dismissed' })
    assert.deepEqual(parseDeskReply('not json', questions), { kind: 'invalid' })
    assert.deepEqual(parseDeskReply('{"answers":[{"id":"q1","value":"9"}]}', questions), { kind: 'invalid' })
})
