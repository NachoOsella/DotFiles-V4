import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AgentStatus } from './agent-status.ts'
import { formatCompletionResult, formatFinalAnswer } from './completion.ts'

const SESSION_FILE = '/tmp/subagents/child-session.jsonl'
const OVERSIZED_REF = `/tmp/subagents/${'r'.repeat(2_000)}.jsonl`

function hasLoneSurrogate(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0
        if (code >= 0xd800 && code <= 0xdfff) return true
    }
    return false
}

describe('bounded completion results', () => {
    it('keeps short success text unchanged', () => {
        const result = formatCompletionResult({
            status: AgentStatus.completed('All checks passed.'),
            sessionFile: SESSION_FILE,
        })!
        assert.equal(result.payload, 'All checks passed.')
        assert.equal(result.truncated, false)
        assert.equal(result.fullResultRef, undefined)
    })

    it('synthesizes a nonempty outcome for empty success', () => {
        const withFile = formatCompletionResult({
            status: AgentStatus.completed(null),
            sessionFile: SESSION_FILE,
        })!
        assert.match(withFile.payload, /no final message/i)
        assert.match(withFile.payload, /followup_task/)
        assert.match(withFile.payload, /Full transcript: .*child-session/)
        assert.equal(withFile.truncated, false)
        assert.equal(withFile.fullResultRef, SESSION_FILE)

        const withoutFile = formatCompletionResult({
            status: AgentStatus.completed('   '),
        })!
        assert.ok(withoutFile.payload.length > 0)
        assert.doesNotMatch(withoutFile.payload, /Full transcript:/)
    })

    it('bounds oversized success and keeps a transcript reference', () => {
        const text = `start ${'x'.repeat(20_000)} end`
        const result = formatCompletionResult({
            status: AgentStatus.completed(text),
            sessionFile: SESSION_FILE,
            sessionId: 'session-123',
        })!
        assert.equal(result.truncated, true)
        assert.equal(result.fullResultRef, SESSION_FILE)
        assert.ok(result.payload.length <= 4_000)
        assert.match(result.payload, /^start x/)
        assert.match(result.payload, /\[truncated \d+ chars; full transcript:/)
        assert.match(result.payload, /child-session\.jsonl/)
        assert.doesNotMatch(result.payload, /session-123/)
        assert.ok(!result.payload.includes(' end'))
    })

    it('bounds oversized errors and keeps recovery guidance', () => {
        const result = formatCompletionResult({
            status: AgentStatus.errored('y'.repeat(20_000)),
            sessionFile: SESSION_FILE,
        })!
        assert.equal(result.truncated, true)
        assert.equal(result.fullResultRef, SESSION_FILE)
        assert.match(result.payload, /^Agent errored: /)
        assert.match(result.payload, /followup_task/)
        assert.match(result.payload, /\[truncated \d+ chars; full transcript:/)
        assert.ok(result.payload.length <= 4_000)
    })

    it('never inlines an oversized transcript reference', () => {
        const longText = 'z'.repeat(20_000)
        const completed = formatCompletionResult({
            status: AgentStatus.completed(longText),
            sessionFile: OVERSIZED_REF,
        })!
        assert.ok(completed.payload.length <= 4_000)
        assert.ok(!completed.payload.includes(OVERSIZED_REF))
        assert.match(
            completed.payload,
            /full transcript reference in result metadata/
        )
        assert.equal(completed.fullResultRef, OVERSIZED_REF)
        assert.equal(completed.truncated, true)

        const empty = formatCompletionResult({
            status: AgentStatus.completed(null),
            sessionFile: OVERSIZED_REF,
        })!
        assert.ok(empty.payload.length <= 4_000)
        assert.ok(!empty.payload.includes(OVERSIZED_REF))
        assert.match(empty.payload, /reference is in the result metadata/)
        assert.equal(empty.fullResultRef, OVERSIZED_REF)
        assert.equal(empty.truncated, false)

        const errored = formatCompletionResult({
            status: AgentStatus.errored('e'.repeat(20_000)),
            sessionFile: OVERSIZED_REF,
        })!
        assert.ok(errored.payload.length <= 4_000)
        assert.ok(!errored.payload.includes(OVERSIZED_REF))
        assert.match(
            errored.payload,
            /full transcript reference in result metadata/
        )
        assert.equal(errored.fullResultRef, OVERSIZED_REF)
        assert.equal(errored.truncated, true)
    })

    it('does not split a surrogate pair at the truncation boundary', () => {
        const text = `${'a'.repeat(3_199)}\uD834\uDD1Etail`
        const result = formatCompletionResult({
            status: AgentStatus.completed(text),
            sessionFile: SESSION_FILE,
        })!
        assert.equal(result.truncated, true)
        assert.ok(result.payload.length <= 4_000)
        assert.equal(hasLoneSurrogate(result.payload), false)
        assert.match(result.payload, /^a+… \[truncated 6 chars/)
    })

    it('returns null for non-terminal statuses', () => {
        for (const status of [
            AgentStatus.pendingInit(),
            AgentStatus.running(),
            AgentStatus.interrupted(),
        ]) {
            assert.equal(
                formatCompletionResult({ status, sessionFile: SESSION_FILE }),
                null
            )
        }
    })

    it('keeps formatFinalAnswer compatible with an optional context', () => {
        assert.equal(
            formatFinalAnswer(AgentStatus.completed('done'), {
                sessionFile: SESSION_FILE,
            }),
            'done'
        )
        assert.match(
            formatFinalAnswer(AgentStatus.completed(null), {
                sessionFile: SESSION_FILE,
            }) ?? '',
            /child-session/
        )
        assert.equal(formatFinalAnswer(AgentStatus.running()), null)
    })
})
