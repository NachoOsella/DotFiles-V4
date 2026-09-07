import assert from 'node:assert/strict'
import test from 'node:test'
import { QuestionnaireState } from './state.ts'

function twoQuestions() {
    return [
        {
            question: 'First?',
            options: [{ label: 'A1' }, { label: 'A2' }],
        },
        {
            question: 'Second?',
            options: [{ label: 'B1' }, { label: 'B2' }],
        },
    ]
}

test('Right-then-select reproduction finishes without missing answers', () => {
    const state = new QuestionnaireState(twoQuestions())
    // Press Right to skip the first question.
    assert.equal(state.moveQuestion(1), true)
    assert.equal(state.questionIndex, 1)
    // Select an answer on the second question.
    const second = state.selectOption(0)
    assert.equal(second.finished, false)
    if (!second.finished && 'movedTo' in second) assert.equal(second.movedTo, 0)
    assert.equal(state.questionIndex, 0)
    assert.equal(state.isComplete(), false)
    assert.equal(state.orderedAnswers(), null)

    const first = state.selectOption(1)
    assert.equal(first.finished, true)
    if (first.finished) {
        assert.equal(first.answers.length, 2)
        assert.equal(first.answers[0].answer, 'A2')
        assert.equal(first.answers[0].index, 2)
        assert.equal(first.answers[1].answer, 'B1')
        assert.equal(first.answers[1].index, 1)
        for (const answer of first.answers) {
            assert.ok(answer.question.length > 0)
            assert.equal(typeof answer.wasCustom, 'boolean')
        }
    }
})

test('navigation backward can change an earlier answer', () => {
    const state = new QuestionnaireState(twoQuestions())
    const first = state.selectOption(0)
    assert.equal(first.finished, false)
    assert.equal(state.questionIndex, 1)
    assert.equal(state.moveQuestion(-1), true)
    const changed = state.selectOption(1)
    assert.equal(changed.finished, false)
    assert.equal(state.questionIndex, 1)
    assert.equal(state.answers.get(0)?.answer, 'A2')
    const done = state.selectOption(1)
    assert.equal(done.finished, true)
    if (done.finished) {
        assert.deepEqual(
            done.answers.map((a) => a.answer),
            ['A2', 'B2']
        )
    }
})

test('answering the last question with gaps goes to first unanswered', () => {
    const state = new QuestionnaireState([
        { question: 'Q1', options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'Q2', options: [{ label: 'c' }, { label: 'd' }] },
        { question: 'Q3', options: [{ label: 'e' }, { label: 'f' }] },
    ])
    const first = state.selectOption(0)
    assert.equal(first.finished, false)
    assert.equal(state.questionIndex, 1)
    assert.equal(state.moveQuestion(1), true)
    assert.equal(state.questionIndex, 2)
    const last = state.selectOption(0)
    assert.equal(last.finished, false)
    if (!last.finished && 'movedTo' in last) assert.equal(last.movedTo, 1)
    assert.equal(state.questionIndex, 1)
    const middle = state.selectOption(1)
    assert.equal(middle.finished, true)
    if (middle.finished) {
        assert.deepEqual(
            middle.answers.map((a) => a.answer),
            ['a', 'd', 'e']
        )
    }
})

test('custom text stores a free-form answer', () => {
    const state = new QuestionnaireState(twoQuestions())
    const otherIndex = state.currentOptions().length - 1
    const editing = state.selectOption(otherIndex)
    assert.deepEqual(editing, { finished: false, editing: true })
    assert.equal(state.editMode, true)
    const done = state.submitCustom('  hello  ')
    assert.equal(done.finished, false)
    assert.equal(state.answers.get(0)?.answer, 'hello')
    assert.equal(state.answers.get(0)?.wasCustom, true)
    assert.equal(state.editMode, false)
})

test('blank custom submit leaves edit mode without saving', () => {
    const state = new QuestionnaireState(twoQuestions())
    const otherIndex = state.currentOptions().length - 1
    state.selectOption(otherIndex)
    assert.equal(state.editMode, true)
    const outcome = state.submitCustom('   ')
    assert.equal(outcome.finished, false)
    if (!outcome.finished) assert.equal(outcome.editing, false)
    assert.equal(state.editMode, false)
    assert.equal(state.answers.has(0), false)
    assert.equal(state.isComplete(), false)
})

test('ordered results follow question order, not answer order', () => {
    const state = new QuestionnaireState(twoQuestions())
    assert.equal(state.moveQuestion(1), true)
    const second = state.selectOption(1)
    assert.equal(second.finished, false)
    const first = state.selectOption(0)
    assert.equal(first.finished, true)
    if (first.finished) {
        assert.equal(first.answers[0].question, 'First?')
        assert.equal(first.answers[1].question, 'Second?')
    }
})
