/**
 * Handoff-quality, coordination, and child-communication evaluations.
 *
 * Deterministic, model-agnostic helpers that score the actual arguments
 * passed to `subagent_spawn` and the ordering of coordination calls.
 * The behavioral interceptor already records tool args, so these evaluators
 * operate on the real recorded `prompt` instead of asking the model to
 * describe what it would do.
 */

export interface HandoffSignal {
    readonly label: string
    /** Case-insensitive substrings; matching any alias satisfies the signal. */
    readonly aliases: ReadonlyArray<string>
}

export interface HandoffEvalCase {
    readonly name: string
    readonly role: string
    /** What the parent already knows and must transfer to the child. */
    readonly parentContext: string
    /** Task instruction given to the parent in the eval. */
    readonly parentTask: string
    readonly requiredSignals: ReadonlyArray<HandoffSignal>
    readonly minimumSignals: number
    /** Expected number of spawn prompts (1 except parallel cases). */
    readonly expectedPrompts?: number
}

export interface HandoffQualityResult {
    readonly passed: boolean
    readonly failures: ReadonlyArray<string>
    readonly matchedSignals: ReadonlyArray<string>
    readonly coverage: number
}

function normalized(text: string) {
    return text.toLowerCase()
}

function matchesSignal(prompt: string, signal: HandoffSignal) {
    const haystack = normalized(prompt)
    return signal.aliases.some((alias) => haystack.includes(normalized(alias)))
}

/** Vague one-liners that force the child to rediscover parent context. */
const VAGUE_PATTERNS = [
    /^investigate( this| the| and fix)?[^.]{0,80}$/i,
    /^fix( this| the| it)?[^.]{0,80}$/i,
    /^review( this| the| it)?[^.]{0,80}$/i,
    /^look at [^.]{1,80}$/i,
    /^check( this| the| it)?[^.]{0,80}$/i,
]

function isVaguePrompt(prompt: string) {
    const trimmed = prompt.trim()
    if (trimmed.length >= 200) return false
    return VAGUE_PATTERNS.some((pattern) =>
        pattern.test(trimmed.replace(/\.$/, ''))
    )
}

/**
 * Score semantic completeness rather than length or exact wording.
 * No rigid OBJECTIVE / CONTEXT / SCOPE template is required.
 */
export function evaluateHandoffQuality(
    prompt: string,
    scenario: HandoffEvalCase
): HandoffQualityResult {
    const failures: string[] = []
    const matched = scenario.requiredSignals
        .filter((signal) => matchesSignal(prompt, signal))
        .map((signal) => signal.label)
    const coverage =
        scenario.requiredSignals.length === 0
            ? 1
            : matched.length / scenario.requiredSignals.length

    if (prompt.trim().length < 40) {
        failures.push('handoff is too short to execute without rediscovery')
    }
    if (isVaguePrompt(prompt)) {
        failures.push(
            'handoff is vague; state the concrete problem and expected outcome instead of "investigate this" / "fix this" / "review this"'
        )
    }
    if (matched.length < scenario.minimumSignals) {
        const missing = scenario.requiredSignals
            .filter((signal) => !matched.includes(signal.label))
            .map((signal) => signal.label)
        failures.push(
            `handoff covers ${matched.length}/${scenario.requiredSignals.length} required signals (need ${scenario.minimumSignals}); missing: ${missing.join(', ')}`
        )
    }
    return {
        passed: failures.length === 0,
        failures,
        matchedSignals: matched,
        coverage,
    }
}

/** Evaluate several parallel prompts (e.g. two independent workers). */
export function evaluateMultiHandoffQuality(
    prompts: ReadonlyArray<string>,
    scenario: HandoffEvalCase
): HandoffQualityResult {
    const expected = scenario.expectedPrompts ?? prompts.length
    if (prompts.length !== expected) {
        return {
            passed: false,
            failures: [`expected ${expected} handoffs, got ${prompts.length}`],
            matchedSignals: [],
            coverage: 0,
        }
    }
    const results = prompts.map((prompt) =>
        evaluateHandoffQuality(prompt, scenario)
    )
    const failures = results.flatMap((result, index) =>
        result.failures.map((failure) => `prompt ${index + 1}: ${failure}`)
    )
    // Parallel handoffs must also separate ownership; each prompt should name
    // its own area so the children do not overlap.
    const lowered = prompts.map((prompt) => normalized(prompt))
    const hasOverlap = lowered.length === 2 && lowered[0] === lowered[1]
    if (hasOverlap) {
        failures.push(
            'parallel handoffs are identical; separate scope and ownership'
        )
    }
    const matched = [...new Set(results.flatMap((r) => r.matchedSignals))]
    const coverage =
        results.length === 0
            ? 0
            : results.reduce((total, r) => total + r.coverage, 0) /
              results.length
    return {
        passed: failures.length === 0,
        failures,
        matchedSignals: matched,
        coverage,
    }
}

/** Extract real recorded spawn prompts from interceptor calls. */
export function extractSpawnPrompts(
    calls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>
): string[] {
    return calls
        .filter((call) => call.name === 'subagent_spawn')
        .map((call) => {
            const args = call.args as Record<string, unknown> | undefined
            return typeof args?.prompt === 'string' ? args.prompt : ''
        })
}

/** Score recorded spawn calls against a handoff scenario. */
export function evaluateRecordedHandoffs(
    calls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>,
    scenario: HandoffEvalCase
): HandoffQualityResult {
    const prompts = extractSpawnPrompts(calls)
    if (
        scenario.expectedPrompts !== undefined &&
        scenario.expectedPrompts > 1
    ) {
        return evaluateMultiHandoffQuality(prompts, scenario)
    }
    if (prompts.length === 0) {
        return {
            passed: false,
            failures: ['no subagent_spawn call was recorded'],
            matchedSignals: [],
            coverage: 0,
        }
    }
    // Score the best prompt so one good handoff among retries still passes,
    // but report failures from the first prompt for actionable feedback.
    const results = prompts.map((prompt) =>
        evaluateHandoffQuality(prompt, scenario)
    )
    const best = results.reduce((a, b) => (b.coverage > a.coverage ? b : a))
    return best ?? results[0]!
}

/**
 * Handoff scenarios where the parent already knows important context.
 * The parent must transfer that context instead of making the child
 * rediscover it. Good handoffs communicate behavior, location, findings,
 * constraints, definition of done, and validation without exact wording.
 */
export const HANDOFF_EVALS: ReadonlyArray<HandoffEvalCase> = [
    {
        name: 'handoff-refresh-token-fix',
        role: 'worker',
        parentContext:
            'You already inspected the auth flow and confirmed that refresh-token rotation is implemented in src/auth/RefreshTokenService.java. The bug is that the old jti remains valid after refresh. Existing architecture and repository boundaries must stay unchanged. Logout is unrelated.',
        parentTask:
            'You already inspected the auth flow and confirmed that refresh-token rotation is implemented in src/auth/RefreshTokenService.java. The bug is that the old jti remains valid after refresh. Existing architecture and repository boundaries must stay unchanged. Logout is unrelated. Implement the fix while I work on another independent part of the auth flow.',
        requiredSignals: [
            {
                label: 'behavior',
                aliases: ['jti', 'old token', 'remains valid', 'after refresh'],
            },
            { label: 'location', aliases: ['RefreshTokenService', 'src/auth'] },
            {
                label: 'finding',
                aliases: [
                    'rotation',
                    'already implemented',
                    'confirmed',
                    'inspected',
                ],
            },
            {
                label: 'constraint',
                aliases: ['architecture', 'boundaries', 'unchanged', 'logout'],
            },
            {
                label: 'definition-of-done',
                aliases: [
                    'invalid after refresh',
                    'no longer valid',
                    'old jti',
                    'must be rejected',
                ],
            },
            {
                label: 'validation',
                aliases: ['test', 'reproduce', 'validate', 'focused'],
            },
        ],
        minimumSignals: 4,
        expectedPrompts: 1,
    },
    {
        name: 'handoff-auth-consumers-investigation',
        role: 'explorer',
        parentContext:
            'You know the UserSession interface in src/auth and need all consumers mapped while you implement the fix elsewhere. The child must not modify files.',
        parentTask:
            'Map every consumer of the UserSession interface in src/auth while I implement the refresh fix. Do not modify files; report file paths and execution paths.',
        requiredSignals: [
            {
                label: 'question',
                aliases: ['consumer', 'usage', 'caller', 'who uses'],
            },
            {
                label: 'location',
                aliases: ['UserSession', 'src/auth', 'interface'],
            },
            {
                label: 'scope',
                aliases: [
                    'map',
                    'list',
                    'report',
                    'do not modify',
                    'without modifying',
                ],
            },
            {
                label: 'context',
                aliases: ['while i', 'independent', 'implement', 'already'],
            },
            {
                label: 'report',
                aliases: [
                    'final report',
                    'cite',
                    'file path',
                    'execution path',
                ],
            },
        ],
        minimumSignals: 4,
        expectedPrompts: 1,
    },
    {
        name: 'handoff-auth-security-review',
        role: 'reviewer',
        parentContext:
            'An authorization change in src/auth is implemented. You need a focused security review for correctness, races, and invariants without rewriting source.',
        parentTask:
            'Review the authorization change in src/auth for security, correctness, and concurrency. Do not rewrite source unless explicitly requested.',
        requiredSignals: [
            {
                label: 'scope',
                aliases: ['authorization', 'security review', 'src/auth'],
            },
            {
                label: 'focus',
                aliases: [
                    'correctness',
                    'race',
                    'invariant',
                    'regression',
                    'contract',
                ],
            },
            {
                label: 'constraint',
                aliases: [
                    'do not rewrite',
                    'without modifying',
                    'unless explicitly',
                    'no edit',
                ],
            },
            {
                label: 'report',
                aliases: ['finding', 'priorit', 'final review', 'validation'],
            },
            { label: 'context', aliases: ['change', 'diff', 'implemented'] },
        ],
        minimumSignals: 4,
        expectedPrompts: 1,
    },
    {
        name: 'handoff-refresh-regression-validation',
        role: 'tester',
        parentContext:
            'A refresh-token regression was fixed. You need focused reproduction with the relevant test command, without modifying application source.',
        parentTask:
            'Reproduce the refresh-token regression with the relevant focused test command and report the outcome. Do not modify application source.',
        requiredSignals: [
            {
                label: 'behavior',
                aliases: ['regression', 'reproduce', 'refresh'],
            },
            {
                label: 'command',
                aliases: ['test', 'command', 'reproduction', 'npm'],
            },
            {
                label: 'scope',
                aliases: [
                    'focused',
                    'relevant test',
                    'without modifying',
                    'do not repair',
                    'do not modify',
                ],
            },
            {
                label: 'report',
                aliases: [
                    'result',
                    'confirmed',
                    'disproved',
                    'failure detail',
                    'outcome',
                ],
            },
            { label: 'context', aliases: ['fix', 'change', 'assigned'] },
        ],
        minimumSignals: 4,
        expectedPrompts: 1,
    },
    {
        name: 'handoff-frontend-backend-auth-parallel',
        role: 'worker',
        parentContext:
            'Frontend and backend authentication areas are mostly independent. Each child owns one area and must not overlap the other.',
        parentTask:
            'Refactor frontend and backend authentication implementations in parallel. The two areas are mostly independent; keep ownership separate.',
        requiredSignals: [
            { label: 'area', aliases: ['frontend', 'backend', 'auth'] },
            {
                label: 'ownership',
                aliases: [
                    'own',
                    'scope',
                    'only',
                    'exclusively',
                    'do not modify',
                ],
            },
            {
                label: 'independence',
                aliases: ['independent', 'parallel', 'separate'],
            },
            {
                label: 'constraint',
                aliases: ['contract', 'api', 'unchanged', 'boundary'],
            },
            {
                label: 'report',
                aliases: ['final report', 'changed', 'validation', 'test'],
            },
        ],
        minimumSignals: 3,
        expectedPrompts: 2,
    },
]

// --- Coordination ------------------------------------------------------------

export interface CoordinationCall {
    readonly name: string
    readonly args?: unknown
}

export interface SynchronizationResult {
    readonly passed: boolean
    readonly failures: ReadonlyArray<string>
}

/**
 * Expected trace: spawn -> useful independent action -> wait ->
 * dependent action. Rejects both immediate waits (lost parallelism) and
 * dependent work completed without synchronizing (stale/redundant results).
 */
export function evaluateSynchronizationBoundary(
    calls: ReadonlyArray<CoordinationCall>,
    options: {
        readonly expectIndependentWork?: boolean
        readonly requireWait?: boolean
    } = {}
): SynchronizationResult {
    const { expectIndependentWork = true, requireWait = true } = options
    const failures: string[] = []
    const names = calls.map((call) => call.name)
    const spawnIndex = names.indexOf('subagent_spawn')
    const waitIndex = names.indexOf('subagent_wait')

    if (spawnIndex === -1) {
        return { passed: false, failures: ['no subagent_spawn in trace'] }
    }
    if (requireWait && waitIndex === -1) {
        failures.push(
            'delegated work was never synchronized with subagent_wait'
        )
        return { passed: false, failures }
    }
    if (waitIndex !== -1 && waitIndex < spawnIndex) {
        failures.push('subagent_wait appears before subagent_spawn')
    }
    if (expectIndependentWork && waitIndex === spawnIndex + 1) {
        failures.push(
            'subagent_wait immediately follows subagent_spawn while useful independent work remains'
        )
    }
    if (waitIndex !== -1) {
        // A dependent follow-up (send/close/second spawn integrating the
        // result) before the wait means the parent crossed the dependency
        // boundary without synchronizing.
        const preWaitDependent = calls
            .slice(spawnIndex + 1, waitIndex)
            .filter(
                (call) =>
                    call.name === 'subagent_send' ||
                    call.name === 'subagent_close'
            )
        if (preWaitDependent.length > 0) {
            failures.push(
                'dependent action before subagent_wait crosses the dependency boundary without the child result'
            )
        }
    }
    return { passed: failures.length === 0, failures }
}

export interface PollingResult {
    readonly passed: boolean
    readonly failures: ReadonlyArray<string>
    readonly checkCount: number
}

/** Parents should not repeatedly poll with subagent_check. */
export function evaluatePolling(
    calls: ReadonlyArray<CoordinationCall>,
    maxAllowedChecks = 2
): PollingResult {
    const checkCount = calls.filter(
        (call) => call.name === 'subagent_check'
    ).length
    const failures: string[] = []
    if (checkCount > maxAllowedChecks) {
        failures.push(
            `called subagent_check ${checkCount} times (max ${maxAllowedChecks}); do not poll while the child works normally`
        )
    }
    // Two back-to-back checks with no other work between them are polling.
    for (let i = 0; i + 1 < calls.length; i++) {
        if (
            calls[i]?.name === 'subagent_check' &&
            calls[i + 1]?.name === 'subagent_check'
        ) {
            failures.push(
                'consecutive subagent_check calls without intervening work'
            )
            break
        }
    }
    return { passed: failures.length === 0, failures, checkCount }
}

export interface QuestionHandlingResult {
    readonly passed: boolean
    readonly failures: ReadonlyArray<string>
}

/**
 * A blocking child question is a request for a decision, not an invitation
 * to take over. The parent should answer with subagent_send and let the
 * child continue instead of immediately modifying its assigned files.
 */
export function evaluateQuestionHandling(
    calls: ReadonlyArray<CoordinationCall>,
    options: { readonly questionAsked: boolean } = { questionAsked: true }
): QuestionHandlingResult {
    if (!options.questionAsked) return { passed: true, failures: [] }
    const failures: string[] = []
    const waitIndex = calls.map((call) => call.name).indexOf('subagent_wait')
    if (waitIndex === -1) {
        return {
            passed: false,
            failures: ['no subagent_wait to receive the blocking question'],
        }
    }
    const afterWait = calls.slice(waitIndex + 1)
    const sendIndex = afterWait.findIndex(
        (call) => call.name === 'subagent_send'
    )
    if (sendIndex === -1) {
        failures.push(
            'child asked a blocking question but the parent never answered with subagent_send'
        )
    } else {
        // A new spawn between the question and the answer suggests takeover
        // instead of answering the child that owns the work.
        const beforeAnswer = afterWait.slice(0, sendIndex)
        if (beforeAnswer.some((call) => call.name === 'subagent_spawn')) {
            failures.push(
                'parent spawned new work before answering the blocking question; answer the child with subagent_send instead of taking over'
            )
        }
    }
    return { passed: failures.length === 0, failures }
}

// --- Child communication -----------------------------------------------------

export interface ChildTrace {
    /** Messages sent via report_to_parent. */
    readonly reportMessages: ReadonlyArray<string>
    /** Tool calls made by the child (name only is enough for footprint). */
    readonly toolCalls: ReadonlyArray<string>
    readonly finalReport: string
    /** Files named in the assignment; used to detect broad exploration. */
    readonly assignedFiles?: ReadonlyArray<string>
    /** Distinct files the child actually inspected or edited. */
    readonly touchedFiles?: ReadonlyArray<string>
    /** Whether the child edited files outside the assigned scope. */
    readonly editedOutsideScope?: boolean
    /** Whether an unrelated issue was visible during the task. */
    readonly unrelatedFound?: boolean
}

export interface ChildCommunicationResult {
    readonly passed: boolean
    readonly failures: ReadonlyArray<string>
}

const PROGRESS_PATTERNS = [
    'progress update',
    'status update',
    'just letting you know',
    'quick update',
    'intermediate discover',
    'wanted to share',
]

const BLOCKING_HINTS = [
    '?',
    'should i',
    'which',
    'need a decision',
    'blocked',
    'missing',
    'choose',
    'decide',
    'required to continue',
]

function looksLikeBlockingQuestion(message: string) {
    const lower = message.toLowerCase()
    return (
        lower.includes('?') &&
        BLOCKING_HINTS.some((hint) => lower.includes(hint))
    )
}

function looksLikeProgress(message: string) {
    const lower = message.toLowerCase()
    if (looksLikeBlockingQuestion(message)) return false
    return (
        PROGRESS_PATTERNS.some((pattern) => lower.includes(pattern)) ||
        (/^(found|discovered|update|status|progress|note:|heads up)/i.test(
            message.trim()
        ) &&
            !lower.includes('?'))
    )
}

/**
 * Deterministic checks for the child policy: report_to_parent only for
 * genuine blockers, small tasks stay small, no broad mapping when the
 * prompt already identifies files, unrelated issues are reported not fixed.
 */
export function evaluateChildTrace(
    trace: ChildTrace,
    options: {
        readonly expectBlocker?: boolean
        readonly smallTask?: boolean
        readonly maxToolCalls?: number
    } = {}
): ChildCommunicationResult {
    const {
        expectBlocker = false,
        smallTask = false,
        maxToolCalls = 8,
    } = options
    const failures: string[] = []

    for (const message of trace.reportMessages) {
        if (looksLikeProgress(message)) {
            failures.push(
                'report_to_parent used for a progress update or discovery; keep those for the final report'
            )
        } else if (!looksLikeBlockingQuestion(message)) {
            failures.push(
                'report_to_parent used for a non-blocking message; use it only for a genuine blocking question'
            )
        }
    }
    if (!expectBlocker && trace.reportMessages.length > 0) {
        // Allow nothing when no blocker is expected; the per-message check
        // above already explains why each message is wrong.
        if (failures.length === 0) {
            failures.push(
                'report_to_parent used without a genuine blocking decision'
            )
        }
    }
    if (expectBlocker && trace.reportMessages.length === 0) {
        failures.push(
            'genuine blocker required report_to_parent but none was sent'
        )
    }
    if (expectBlocker && trace.reportMessages.length > 1) {
        failures.push(
            'multiple report_to_parent calls for one blocker; ask once and finish the run'
        )
    }

    if (smallTask && trace.toolCalls.length > maxToolCalls) {
        failures.push(
            `small task used ${trace.toolCalls.length} tool calls (max ${maxToolCalls}); stop once the definition of done is satisfied`
        )
    }

    if (
        trace.assignedFiles &&
        trace.assignedFiles.length > 0 &&
        trace.touchedFiles
    ) {
        const assigned = new Set(
            trace.assignedFiles.map((f) => f.toLowerCase())
        )
        const outside = trace.touchedFiles.filter(
            (f) => !assigned.has(f.toLowerCase())
        )
        if (trace.touchedFiles.length >= 6 && outside.length >= 4) {
            failures.push(
                'broad repository exploration despite the prompt identifying the relevant files; start from the supplied context'
            )
        }
    }

    if (trace.editedOutsideScope) {
        failures.push(
            'edited files outside the assigned scope; leave unrelated issues for the final report'
        )
    }
    if (trace.unrelatedFound && !trace.editedOutsideScope) {
        const report = trace.finalReport.toLowerCase()
        const mentions =
            report.includes('out-of-scope') ||
            report.includes('out of scope') ||
            report.includes('unrelated') ||
            report.includes('non-blocking') ||
            report.includes('relevant out-of-scope')
        if (!mentions && trace.finalReport.trim().length > 0) {
            failures.push(
                'unrelated finding was not recorded in the final report'
            )
        }
    }

    if (trace.finalReport.trim().length < 20) {
        failures.push(
            'final report is missing; report outcome, files, validation, and blockers'
        )
    }

    return { passed: failures.length === 0, failures }
}

/** Scenarios for child-communication behavior (used by tests and model evals). */
export const CHILD_COMMUNICATION_CASES = [
    {
        name: 'non-blocking-discovery-stays-in-final-report',
        description:
            'Intermediate discoveries belong in the final report, not report_to_parent.',
    },
    {
        name: 'progress-does-not-use-report-to-parent',
        description: 'Progress updates must not interrupt the parent.',
    },
    {
        name: 'genuine-blocker-may-ask-once',
        description:
            'An unresolved parent decision may use report_to_parent exactly once.',
    },
    {
        name: 'small-task-stops-after-focused-validation',
        description:
            'A localized fix ends after localized investigation and focused validation.',
    },
    {
        name: 'no-broad-mapping-when-files-given',
        description:
            'Start from supplied files instead of mapping the repository.',
    },
    {
        name: 'unrelated-issue-reported-not-fixed',
        description: 'Record out-of-scope findings instead of fixing them.',
    },
] as const
