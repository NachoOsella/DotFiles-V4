import assert from 'node:assert/strict'
import test from 'node:test'
import {
    CHILD_COMMUNICATION_CASES,
    evaluateChildTrace,
    evaluateHandoffQuality,
    evaluateMultiHandoffQuality,
    evaluatePolling,
    evaluateQuestionHandling,
    evaluateRecordedHandoffs,
    evaluateSynchronizationBoundary,
    HANDOFF_EVALS,
} from './src/handoff-eval.ts'

function handoffCase(name: string) {
    const scenario = HANDOFF_EVALS.find((item) => item.name === name)
    if (!scenario) throw new Error(`missing handoff case ${name}`)
    return scenario
}

const GOOD_REFRESH_HANDOFF = `Fix the refresh-token bug where the old jti remains valid after refresh.

Context: I already inspected the auth flow and confirmed refresh-token rotation is implemented in src/auth/RefreshTokenService.java.

Scope: only src/auth/RefreshTokenService.java. Existing architecture and repository boundaries must stay unchanged. Logout is unrelated and must not change.

Definition of done: after refresh the old jti is invalid and must be rejected; the new token works.

Validate with the focused refresh-token test and reproduce the rotation case. Report changed files, validation result, and any blockers in the final report.`

test('handoff evals cover implementation, explorer, reviewer, tester, and parallel workers', () => {
    const names = HANDOFF_EVALS.map((item) => item.name)
    assert.ok(names.includes('handoff-refresh-token-fix'))
    assert.ok(names.includes('handoff-auth-consumers-investigation'))
    assert.ok(names.includes('handoff-auth-security-review'))
    assert.ok(names.includes('handoff-refresh-regression-validation'))
    assert.ok(names.includes('handoff-frontend-backend-auth-parallel'))
    for (const item of HANDOFF_EVALS) {
        assert.ok(item.parentContext.length > 0)
        assert.ok(item.parentTask.length > 0)
        assert.ok(item.requiredSignals.length >= 4)
        assert.ok(item.minimumSignals >= 3)
    }
})

test('poor vague handoffs fail while complete handoffs pass', () => {
    const scenario = handoffCase('handoff-refresh-token-fix')
    const poor = evaluateHandoffQuality(
        'Investigate and fix the refresh token issue.',
        scenario
    )
    assert.equal(poor.passed, false)
    assert.ok(poor.failures.length > 0)
    assert.ok(poor.matchedSignals.length < scenario.minimumSignals)

    const good = evaluateHandoffQuality(GOOD_REFRESH_HANDOFF, scenario)
    assert.deepEqual(good.failures, [])
    assert.equal(good.passed, true)
    assert.ok(good.matchedSignals.length >= scenario.minimumSignals)
})

test('handoff scoring is semantic, not length or template based', () => {
    const scenario = handoffCase('handoff-refresh-token-fix')
    // Long generic text without the required signals still fails.
    const longGeneric =
        `Please do a very thorough and comprehensive job on the auth system. `.repeat(
            10
        )
    assert.equal(evaluateHandoffQuality(longGeneric, scenario).passed, false)
    // Naturally written but complete handoff passes without rigid headings.
    const natural = GOOD_REFRESH_HANDOFF.replaceAll('\n\n', ' ')
    assert.equal(evaluateHandoffQuality(natural, scenario).passed, true)
})

test('explorer, reviewer, and tester handoffs require their own signals', () => {
    const explorer = handoffCase('handoff-auth-consumers-investigation')
    assert.equal(
        evaluateHandoffQuality('Look at UserSession.', explorer).passed,
        false
    )
    assert.equal(
        evaluateHandoffQuality(
            'Map every consumer, usage, and caller of the UserSession interface in src/auth. While I implement the refresh fix independently, do not modify files. In the final report cite file paths and execution paths for each consumer.',
            explorer
        ).passed,
        true
    )

    const reviewer = handoffCase('handoff-auth-security-review')
    assert.equal(evaluateHandoffQuality('Review this.', reviewer).passed, false)
    assert.equal(
        evaluateHandoffQuality(
            'Review the authorization change in src/auth for security, correctness, races, invariants, and contract regressions. Do not rewrite source unless explicitly requested. Report prioritized findings with validation in the final review. The change is already implemented as a diff.',
            reviewer
        ).passed,
        true
    )

    const tester = handoffCase('handoff-refresh-regression-validation')
    assert.equal(evaluateHandoffQuality('Fix this.', tester).passed, false)
    assert.equal(
        evaluateHandoffQuality(
            'Reproduce the refresh regression with the focused relevant test command (npm test refresh). Keep validation focused without modifying application source and do not repair code. Report commands, results, confirmed or disproved behavior, and failure details with outcome. The fix for this change is assigned separately.',
            tester
        ).passed,
        true
    )
})

test('parallel worker handoffs require separate ownership', () => {
    const scenario = handoffCase('handoff-frontend-backend-auth-parallel')
    const frontend = `Own only the frontend auth area. Refactor the frontend login flow independently in parallel; do not modify backend files. Keep the API contract unchanged. Report changed files and focused test validation in the final report.`
    const backend = `Own only the backend auth area. Refactor the backend token validation independently in parallel; do not modify frontend files. Keep the API boundary unchanged. Report changed files and focused test validation in the final report.`
    assert.equal(
        evaluateMultiHandoffQuality([frontend, backend], scenario).passed,
        true
    )
    assert.equal(
        evaluateMultiHandoffQuality(['Fix auth.', 'Fix auth too.'], scenario)
            .passed,
        false
    )
    assert.equal(
        evaluateMultiHandoffQuality([frontend], scenario).passed,
        false
    )
})

test('recorded spawn prompts are scored from interceptor args', () => {
    const scenario = handoffCase('handoff-refresh-token-fix')
    const calls = [
        { name: 'subagent_spawn', args: { prompt: 'Fix this.', name: 'x' } },
        {
            name: 'subagent_spawn',
            args: { prompt: GOOD_REFRESH_HANDOFF, name: 'y' },
        },
    ]
    // Best prompt wins so retries do not mask a good handoff.
    assert.equal(evaluateRecordedHandoffs(calls, scenario).passed, true)
    assert.equal(
        evaluateRecordedHandoffs(
            [
                {
                    name: 'subagent_spawn',
                    args: { prompt: 'Fix this.', name: 'x' },
                },
            ],
            scenario
        ).passed,
        false
    )
    assert.equal(evaluateRecordedHandoffs([], scenario).passed, false)
})

test('synchronization boundary rejects immediate waits and missing waits', () => {
    // Good: spawn, independent work, wait, dependent action.
    assert.deepEqual(
        evaluateSynchronizationBoundary([
            { name: 'subagent_spawn' },
            { name: 'subagent_list' },
            { name: 'subagent_wait' },
            { name: 'subagent_send' },
        ]).passed,
        true
    )
    // Bad: immediate wait eliminates parallelism.
    const immediate = evaluateSynchronizationBoundary([
        { name: 'subagent_spawn' },
        { name: 'subagent_wait' },
    ])
    assert.equal(immediate.passed, false)
    assert.match(immediate.failures.join(' '), /immediately/)
    // Bad: dependent work without synchronizing.
    const missing = evaluateSynchronizationBoundary(
        [{ name: 'subagent_spawn' }, { name: 'subagent_list' }],
        { requireWait: true }
    )
    assert.equal(missing.passed, false)
    assert.match(missing.failures.join(' '), /never synchronized/)
})

test('blocking questions expect subagent_send, not takeover', () => {
    assert.equal(
        evaluateQuestionHandling(
            [
                { name: 'subagent_spawn' },
                { name: 'subagent_wait' },
                { name: 'subagent_send' },
            ],
            { questionAsked: true }
        ).passed,
        true
    )
    const noAnswer = evaluateQuestionHandling(
        [{ name: 'subagent_spawn' }, { name: 'subagent_wait' }],
        { questionAsked: true }
    )
    assert.equal(noAnswer.passed, false)
    const takeover = evaluateQuestionHandling(
        [
            { name: 'subagent_spawn' },
            { name: 'subagent_wait' },
            { name: 'subagent_spawn' },
            { name: 'subagent_send' },
        ],
        { questionAsked: true }
    )
    assert.equal(takeover.passed, false)
    assert.equal(
        evaluateQuestionHandling([{ name: 'subagent_spawn' }], {
            questionAsked: false,
        }).passed,
        true
    )
})

test('repeated polling with subagent_check fails', () => {
    assert.equal(
        evaluatePolling([
            { name: 'subagent_spawn' },
            { name: 'subagent_check' },
            { name: 'subagent_wait' },
        ]).passed,
        true
    )
    const polling = evaluatePolling([
        { name: 'subagent_spawn' },
        { name: 'subagent_check' },
        { name: 'subagent_check' },
        { name: 'subagent_check' },
    ])
    assert.equal(polling.passed, false)
    assert.equal(polling.checkCount, 3)
    const consecutive = evaluatePolling([
        { name: 'subagent_spawn' },
        { name: 'subagent_check' },
        { name: 'subagent_check' },
    ])
    assert.equal(consecutive.passed, false)
})

test('child communication covers six required behaviors', () => {
    assert.equal(CHILD_COMMUNICATION_CASES.length, 6)

    // Non-blocking discovery stays in the final report.
    const discovery = evaluateChildTrace(
        {
            reportMessages: [
                'Found an interesting caching pattern worth sharing.',
            ],
            toolCalls: ['read'],
            finalReport:
                'Fixed the assigned bug. Validation: focused test passed.',
        },
        {}
    )
    assert.equal(discovery.passed, false)

    // Progress must not use report_to_parent.
    const progress = evaluateChildTrace(
        {
            reportMessages: ['Progress update: halfway done.'],
            toolCalls: ['read', 'edit'],
            finalReport: 'Done. Validation: focused test passed with details.',
        },
        {}
    )
    assert.equal(progress.passed, false)

    // Genuine blocker may ask once.
    const blocker = evaluateChildTrace(
        {
            reportMessages: [
                'Which API should I use for token invalidation? The task allows either the legacy revoke or the new deny-list; I need a decision to continue correctly. Alternatives: revoke (simpler) vs deny-list (matches rotation).',
            ],
            toolCalls: ['read'],
            finalReport:
                'Waiting on parent decision. Inspected RefreshTokenService. No validation yet but files inspected.',
        },
        { expectBlocker: true }
    )
    assert.equal(blocker.passed, true)

    // Small task stops after focused validation.
    const small = evaluateChildTrace(
        {
            reportMessages: [],
            toolCalls: ['read', 'edit'],
            finalReport:
                'Fixed null check in handler. Files: src/handler.ts. Validation: focused unit test passed.',
        },
        { smallTask: true }
    )
    assert.equal(small.passed, true)
    const bloated = evaluateChildTrace(
        {
            reportMessages: [],
            toolCalls: [
                'read',
                'grep',
                'find',
                'read',
                'grep',
                'read',
                'bash',
                'bash',
                'bash',
                'bash',
            ],
            finalReport:
                'Fixed null check. Files: src/handler.ts. Validation: focused test passed.',
        },
        { smallTask: true }
    )
    assert.equal(bloated.passed, false)

    // No broad mapping when files are given.
    const focused = evaluateChildTrace(
        {
            reportMessages: [],
            toolCalls: ['read', 'read'],
            finalReport:
                'Implemented fix. Files: src/auth/RefreshTokenService.java. Validation: focused test passed.',
            assignedFiles: ['src/auth/RefreshTokenService.java'],
            touchedFiles: ['src/auth/RefreshTokenService.java'],
        },
        {}
    )
    assert.equal(focused.passed, true)
    const broad = evaluateChildTrace(
        {
            reportMessages: [],
            toolCalls: ['read', 'read', 'read', 'read', 'read', 'read'],
            finalReport:
                'Implemented fix. Files: many. Validation: focused test passed with details.',
            assignedFiles: ['src/auth/RefreshTokenService.java'],
            touchedFiles: [
                'a.ts',
                'b.ts',
                'c.ts',
                'd.ts',
                'e.ts',
                'f.ts',
                'g.ts',
            ],
        },
        {}
    )
    assert.equal(broad.passed, false)

    // Unrelated issues are reported, not fixed.
    const reported = evaluateChildTrace(
        {
            reportMessages: [],
            toolCalls: ['read', 'edit'],
            finalReport:
                'Fixed assigned bug. Validation: focused test passed. Note: found an unrelated auth logging issue (out-of-scope, left alone).',
            assignedFiles: ['src/auth/RefreshTokenService.java'],
            unrelatedFound: true,
        },
        {}
    )
    assert.equal(reported.passed, true)
    const fixedUnrelated = evaluateChildTrace(
        {
            reportMessages: [],
            toolCalls: ['read', 'edit'],
            finalReport:
                'Fixed assigned bug and also fixed the unrelated logging issue. Validation: focused test passed with details.',
            editedOutsideScope: true,
            unrelatedFound: true,
        },
        {}
    )
    assert.equal(fixedUnrelated.passed, false)
})
