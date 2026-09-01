import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type DelegationMode = 'solo' | 'assistant' | 'orchestrator'

export interface DelegationEvalCase {
    readonly name: string
    readonly prompt: string
    readonly expectedMode: DelegationMode
    readonly expectedAgentRange: readonly [number, number]
    readonly expectedRoles?: ReadonlyArray<string>
}

export interface DelegationObservation {
    readonly agentCount: number
    readonly roles: ReadonlyArray<string>
    readonly immediatelyWaited: boolean
}

export interface DelegationEvalResult {
    readonly passed: boolean
    readonly failures: ReadonlyArray<string>
}

export interface DelegationModelRequest {
    readonly scenario: DelegationEvalCase
    readonly instructions: string
}

export type DelegationModel = (
    request: DelegationModelRequest
) => Promise<string>

export interface DelegationEvalRun {
    readonly scenario: DelegationEvalCase
    readonly observation?: DelegationObservation
    readonly result: DelegationEvalResult
    readonly response?: string
}

export interface DelegationEvalSummary {
    readonly passRate: number
    readonly soloOverDelegationRate: number
    readonly assistantAccuracy: number
    readonly orchestratorAccuracy: number
    readonly averageAgentsRequested: number
    readonly immediateWaitRate: number
    readonly roleSelectionAccuracy: number
}

export interface DelegationEvalSuiteResult {
    readonly passed: boolean
    readonly runs: ReadonlyArray<DelegationEvalRun>
    readonly summary: DelegationEvalSummary
}

const DELEGATION_EVAL_INSTRUCTIONS = `
Evaluate the parent agent's delegation decision for the scenario below. Do not
perform the task. Choose the smallest useful collaboration plan under these
rules: do local, small, or sequential work yourself; use one bounded assistant
only for independent research, review, or validation; use multiple children
only for substantial independent workstreams. The parent should not wait
immediately after spawning unless the scenario requires it.

Return only one JSON object with this exact shape:
{"agentCount":0,"roles":[],"immediatelyWaited":false}

agentCount is the number of children the parent should spawn. roles contains
one role for each child and may use default, explorer, worker, reviewer, or
tester. immediatelyWaited says whether the parent immediately waits for the
children instead of continuing useful work.
`.trim()

/** Compare a recorded model trace with one of the delegation scenarios. */
export function evaluateDelegation(
    scenario: DelegationEvalCase,
    observation: DelegationObservation
): DelegationEvalResult {
    const [minimum, maximum] = scenario.expectedAgentRange
    const failures: string[] = []
    if (observation.agentCount < minimum || observation.agentCount > maximum) {
        failures.push(
            `expected ${minimum}-${maximum} agents, got ${observation.agentCount}`
        )
    }
    for (const role of scenario.expectedRoles ?? []) {
        if (!observation.roles.includes(role))
            failures.push(`expected role ${role}`)
    }
    if (observation.agentCount > 0 && observation.immediatelyWaited)
        failures.push('delegation was followed by an immediate wait')
    return { passed: failures.length === 0, failures }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** Parse the strict JSON contract while tolerating a markdown code fence. */
export function parseDelegationObservation(
    response: string
): DelegationObservation {
    const candidates = [response.trim()]
    for (const match of response.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
        candidates.push(match[1].trim())
    const objectStart = response.indexOf('{')
    const objectEnd = response.lastIndexOf('}')
    if (objectStart >= 0 && objectEnd > objectStart)
        candidates.push(response.slice(objectStart, objectEnd + 1))

    for (const candidate of candidates) {
        try {
            const value: unknown = JSON.parse(candidate)
            if (!isRecord(value)) continue
            const { agentCount, roles, immediatelyWaited } = value
            if (
                typeof agentCount === 'number' &&
                Number.isInteger(agentCount) &&
                agentCount >= 0 &&
                Array.isArray(roles) &&
                roles.every((role) => typeof role === 'string') &&
                typeof immediatelyWaited === 'boolean'
            ) {
                return {
                    agentCount,
                    roles: roles as string[],
                    immediatelyWaited,
                }
            }
        } catch {
            // Try the next representation before reporting a malformed answer.
        }
    }
    throw new Error(
        'model response did not contain a valid delegation JSON object'
    )
}

/** Execute every scenario through a model adapter and score its response. */
export async function runDelegationEvals(
    model: DelegationModel,
    scenarios: ReadonlyArray<DelegationEvalCase> = DELEGATION_EVALS
): Promise<DelegationEvalSuiteResult> {
    const runs: DelegationEvalRun[] = []
    for (const scenario of scenarios) {
        try {
            const response = await model({
                scenario,
                instructions: `${DELEGATION_EVAL_INSTRUCTIONS}\n\nScenario: ${scenario.prompt}`,
            })
            const observation = parseDelegationObservation(response)
            runs.push({
                scenario,
                observation,
                response,
                result: evaluateDelegation(scenario, observation),
            })
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)
            runs.push({
                scenario,
                result: { passed: false, failures: [message] },
            })
        }
    }
    const observed = runs.filter(
        (run): run is DelegationEvalRun & { observation: DelegationObservation } =>
            run.observation !== undefined
    )
    const ratio = (numerator: number, denominator: number) =>
        denominator === 0 ? 0 : numerator / denominator
    const byMode = (mode: DelegationMode) =>
        observed.filter((run) => run.scenario.expectedMode === mode)
    const delegated = observed.filter((run) => run.observation.agentCount > 0)
    const roleCases = observed.filter(
        (run) => (run.scenario.expectedRoles?.length ?? 0) > 0
    )
    const roleMatches = roleCases.filter((run) =>
        run.scenario.expectedRoles?.every((role) =>
            run.observation.roles.includes(role)
        )
    )
    return {
        passed: runs.every((run) => run.result.passed),
        runs,
        summary: {
            passRate: ratio(
                runs.filter((run) => run.result.passed).length,
                runs.length
            ),
            soloOverDelegationRate: ratio(
                byMode('solo').filter(
                    (run) => run.observation.agentCount > 0
                ).length,
                byMode('solo').length
            ),
            assistantAccuracy: ratio(
                byMode('assistant').filter((run) => run.result.passed).length,
                byMode('assistant').length
            ),
            orchestratorAccuracy: ratio(
                byMode('orchestrator').filter((run) => run.result.passed)
                    .length,
                byMode('orchestrator').length
            ),
            averageAgentsRequested: ratio(
                observed.reduce(
                    (total, run) => total + run.observation.agentCount,
                    0
                ),
                observed.length
            ),
            immediateWaitRate: ratio(
                delegated.filter((run) => run.observation.immediatelyWaited)
                    .length,
                delegated.length
            ),
            roleSelectionAccuracy: ratio(roleMatches.length, roleCases.length),
        },
    }
}

export interface PiCliDelegationModelOptions {
    readonly command?: string
    readonly model?: string
    readonly thinking?: string
    readonly cwd?: string
    readonly timeoutMs?: number
}

/** Use the installed Pi CLI as a real model adapter without enabling tools. */
export function createPiCliDelegationModel(
    options: PiCliDelegationModelOptions = {}
): DelegationModel {
    const run = promisify(execFile)
    return async ({ instructions }) => {
        const args = [
            '--no-session',
            '--no-extensions',
            '--no-tools',
            '--no-context-files',
            '--mode',
            'text',
            '--system-prompt',
            'Return only the JSON object requested by the evaluation prompt.',
            '--print',
        ]
        if (options.model) args.push('--model', options.model)
        if (options.thinking) args.push('--thinking', options.thinking)
        args.push('--', instructions)
        try {
            const result = await run(options.command ?? 'pi', args, {
                cwd: options.cwd,
                timeout: options.timeoutMs ?? 120_000,
                maxBuffer: 64 * 1024,
            })
            return result.stdout
        } catch (error) {
            const details =
                isRecord(error) && typeof error.stderr === 'string'
                    ? error.stderr.trim()
                    : undefined
            throw new Error(
                details
                    ? `${error instanceof Error ? error.message : String(error)}: ${details}`
                    : error instanceof Error
                      ? error.message
                      : String(error)
            )
        }
    }
}

/**
 * Small, model-agnostic scenarios for evaluating delegation decisions. The
 * cases are executed by runDelegationEvals; the static data only defines the
 * expected collaboration budget.
 */
export const DELEGATION_EVALS: ReadonlyArray<DelegationEvalCase> = [
    {
        name: 'rename-local-method',
        prompt: 'Rename this method and update its two call sites.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'explain-test-failure',
        prompt: 'Explain why this unit test is failing.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'dto-validation',
        prompt: 'Add validation to this DTO.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'small-refactor',
        prompt: 'Extract this three-line helper and update the local caller.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'single-file-css-fix',
        prompt: 'Fix the spacing regression in this component stylesheet.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'explain-api',
        prompt: 'Explain the request lifecycle for this API endpoint.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'update-one-test',
        prompt: 'Update this test for the new error message.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'local-bug-fix',
        prompt: 'Fix the null check in this function and run its focused test.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'quick-search',
        prompt: 'Find the definition of UserSession and show its fields.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'small-config-change',
        prompt: 'Change this timeout from 10 seconds to 15 seconds.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'related-files-local-fix',
        prompt: 'Read these two related files and fix a localized bug.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'single-symbol-explanation',
        prompt: 'Find one symbol definition and explain it.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'small-change-focused-test',
        prompt: 'Implement a small change and run one focused test.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'tightly-coupled-three-file-change',
        prompt: 'Make the same small change across three tightly coupled files.',
        expectedMode: 'solo',
        expectedAgentRange: [0, 0],
    },
    {
        name: 'compatibility-investigation',
        prompt: 'Investigate an unrelated compatibility concern while I implement the feature.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['explorer'],
    },
    {
        name: 'independent-backend-frontend-change',
        prompt: 'Implement backend and frontend changes that can proceed independently.',
        expectedMode: 'orchestrator',
        expectedAgentRange: [2, 2],
        expectedRoles: ['worker'],
    },
    {
        name: 'endpoint-with-deprecation-search',
        prompt: 'Implement this endpoint and check whether other endpoints still use the deprecated response DTO.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['explorer'],
    },
    {
        name: 'concurrency-review',
        prompt: 'Fix this concurrency bug and independently review the final diff for races.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['reviewer'],
    },
    {
        name: 'independent-validation',
        prompt: 'Implement the parser change while another agent runs focused validation.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['tester'],
    },
    {
        name: 'isolated-codebase-investigation',
        prompt: 'Implement the fix while independently mapping all consumers of this interface.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['explorer'],
    },
    {
        name: 'security-second-opinion',
        prompt: 'Implement this authorization change and get a focused security review in parallel.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['reviewer'],
    },
    {
        name: 'regression-validation',
        prompt: 'Fix the regression and independently reproduce it with the relevant test command.',
        expectedMode: 'assistant',
        expectedAgentRange: [1, 1],
        expectedRoles: ['tester'],
    },
    {
        name: 'frontend-backend-auth',
        prompt: 'Refactor frontend and backend authentication implementations. The two areas are mostly independent.',
        expectedMode: 'orchestrator',
        expectedAgentRange: [2, 4],
        expectedRoles: ['worker'],
    },
    {
        name: 'module-security-audit',
        prompt: 'Audit five independent modules for security issues.',
        expectedMode: 'orchestrator',
        expectedAgentRange: [2, 5],
        expectedRoles: ['reviewer'],
    },
    {
        name: 'platform-migration',
        prompt: 'Migrate the database, API client, and deployment configuration in parallel.',
        expectedMode: 'orchestrator',
        expectedAgentRange: [2, 4],
        expectedRoles: ['worker'],
    },
    {
        name: 'multi-package-test-upgrade',
        prompt: 'Upgrade test infrastructure across four independent packages and integrate the results.',
        expectedMode: 'orchestrator',
        expectedAgentRange: [2, 4],
        expectedRoles: ['tester'],
    },
] as const
