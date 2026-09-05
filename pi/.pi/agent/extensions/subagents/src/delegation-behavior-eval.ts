import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { SUBAGENT_ORCHESTRATION_TOOL_NAMES } from './collaboration-policy.ts'
import {
    DELEGATION_EVALS,
    evaluateDelegation,
    hasImmediateWait,
    type DelegationEvalCase,
    type DelegationEvalResult,
    type DelegationMode,
    type DelegationObservation,
} from '../delegation-evals.ts'
import {
    evaluatePolling,
    evaluateQuestionHandling,
    evaluateRecordedHandoffs,
    evaluateSynchronizationBoundary,
    HANDOFF_EVALS,
    type HandoffEvalCase,
    type HandoffQualityResult,
} from './handoff-eval.ts'

interface BehaviorToolCall {
    readonly name: string
    readonly args: unknown
}

export interface BehavioralDelegationObservation extends DelegationObservation {
    readonly calls: ReadonlyArray<BehaviorToolCall>
}

export interface BehavioralDelegationRun {
    readonly scenario: DelegationEvalCase
    readonly observation?: BehavioralDelegationObservation
    readonly result: DelegationEvalResult
    readonly response?: string
}

export interface BehavioralDelegationSummary {
    readonly overallPassRate: number
    readonly soloOverDelegationRate: number
    readonly assistantModeAccuracy: number
    readonly orchestratorModeAccuracy: number
    readonly averageChildrenSpawned: number
    readonly immediateWaitRate: number
    readonly roleSelectionAccuracy: number
}

export interface BehavioralDelegationSuiteResult {
    readonly passed: boolean
    readonly runs: ReadonlyArray<BehavioralDelegationRun>
    readonly summary: BehavioralDelegationSummary
}

export interface BehavioralDelegationOptions {
    readonly model: string
    readonly command?: string
    readonly cwd?: string
    readonly timeoutMs?: number
}

const exec = promisify(execFile)
const behaviorToolsPath = fileURLToPath(
    new URL('./delegation-behavior-tools.ts', import.meta.url)
)

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function readCalls(logPath: string): BehaviorToolCall[] {
    if (!fs.existsSync(logPath)) return []
    return fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
            try {
                const value: unknown = JSON.parse(line)
                if (
                    !isRecord(value) ||
                    typeof value.name !== 'string' ||
                    !('args' in value)
                )
                    return []
                return [{ name: value.name, args: value.args }]
            } catch {
                return []
            }
        })
}

function spawnRoles(calls: ReadonlyArray<BehaviorToolCall>) {
    return calls
        .filter((call) => call.name === 'subagent_spawn')
        .map((call) => {
            const args = isRecord(call.args) ? call.args : undefined
            return typeof args?.agent_type === 'string'
                ? args.agent_type
                : 'default'
        })
}

export function spawnPrompts(calls: ReadonlyArray<BehaviorToolCall>): string[] {
    return calls
        .filter((call) => call.name === 'subagent_spawn')
        .map((call) => {
            const args = isRecord(call.args) ? call.args : undefined
            return typeof args?.prompt === 'string' ? args.prompt : ''
        })
}

export function evaluateBehaviorHandoff(
    calls: ReadonlyArray<BehaviorToolCall>,
    scenario: HandoffEvalCase
): HandoffQualityResult {
    return evaluateRecordedHandoffs(calls, scenario)
}

export function evaluateBehaviorSynchronization(
    calls: ReadonlyArray<BehaviorToolCall>,
    options?: Parameters<typeof evaluateSynchronizationBoundary>[1]
) {
    return evaluateSynchronizationBoundary(calls, options)
}

export function evaluateBehaviorPolling(
    calls: ReadonlyArray<BehaviorToolCall>,
    maxAllowedChecks?: number
) {
    return evaluatePolling(calls, maxAllowedChecks)
}

export function evaluateBehaviorQuestionHandling(
    calls: ReadonlyArray<BehaviorToolCall>,
    options?: Parameters<typeof evaluateQuestionHandling>[1]
) {
    return evaluateQuestionHandling(calls, options)
}

export { HANDOFF_EVALS }
export type { HandoffEvalCase, HandoffQualityResult }

function observedDelegation(
    calls: ReadonlyArray<BehaviorToolCall>
): BehavioralDelegationObservation {
    const roles = spawnRoles(calls)
    return {
        agentCount: roles.length,
        roles,
        immediatelyWaited: hasImmediateWait(calls),
        calls,
    }
}

function ratio(numerator: number, denominator: number) {
    return denominator === 0 ? 0 : numerator / denominator
}

function modeAccuracy(
    runs: ReadonlyArray<BehavioralDelegationRun>,
    mode: DelegationMode
) {
    const selected = runs.filter(
        (run) => run.scenario.expectedMode === mode && run.observation
    )
    return ratio(
        selected.filter((run) => run.result.passed).length,
        selected.length
    )
}

export function buildBehaviorEvalPrompt(scenario: DelegationEvalCase) {
    return `Act as the parent agent for the task below.
Use the available collaboration tools normally when delegation is useful.
Tool calls are intercepted and do not launch real child work.

Task: ${scenario.prompt}`
}

export function buildBehaviorEvalArgs(
    options: BehavioralDelegationOptions,
    instructions: string
) {
    return [
        '--no-session',
        '--no-extensions',
        '--mode',
        'text',
        '--tools',
        SUBAGENT_ORCHESTRATION_TOOL_NAMES.join(','),
        '--extension',
        behaviorToolsPath,
        '--model',
        options.model,
        '--print',
        '--',
        instructions,
    ]
}

async function runScenario(
    options: BehavioralDelegationOptions,
    scenario: DelegationEvalCase,
    logPath: string
): Promise<BehavioralDelegationRun> {
    const args = buildBehaviorEvalArgs(
        options,
        buildBehaviorEvalPrompt(scenario)
    )
    let response: string | undefined
    let failure: string | undefined
    try {
        const result = await exec(options.command ?? 'pi', args, {
            cwd: options.cwd,
            env: { ...process.env, PI_SUBAGENTS_BEHAVIOR_LOG: logPath },
            timeout: options.timeoutMs ?? 120_000,
            maxBuffer: 128 * 1024,
        })
        response = result.stdout
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
    }
    const observation = observedDelegation(readCalls(logPath))
    const result = failure
        ? { passed: false, failures: [failure] }
        : evaluateDelegation(scenario, observation)
    return {
        scenario,
        observation,
        result,
        ...(response !== undefined ? { response } : {}),
    }
}

/**
 * Run the optional behavioral suite through the real Pi parent setup. Only
 * collaboration tool calls are executed, and each one is intercepted without
 * spawning child work.
 */
export async function runBehavioralDelegationEvals(
    options: BehavioralDelegationOptions,
    scenarios: ReadonlyArray<DelegationEvalCase> = DELEGATION_EVALS
): Promise<BehavioralDelegationSuiteResult> {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'subagents-behavior-eval-')
    )
    const runs: BehavioralDelegationRun[] = []
    try {
        for (const scenario of scenarios) {
            const logPath = path.join(directory, `${scenario.name}.jsonl`)
            runs.push(await runScenario(options, scenario, logPath))
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }

    const observed = runs.filter(
        (
            run
        ): run is BehavioralDelegationRun & {
            observation: BehavioralDelegationObservation
        } => run.observation !== undefined
    )
    const delegated = observed.filter((run) => run.observation.agentCount > 0)
    const roleCases = observed.filter(
        (run) => (run.scenario.expectedRoles?.length ?? 0) > 0
    )
    const roleMatches = roleCases.filter((run) => {
        const expected = run.scenario.expectedRoles ?? []
        const roles = run.observation.roles
        return (
            roles.length === run.observation.agentCount &&
            expected.every((role) => roles.includes(role)) &&
            roles.every((role) => expected.includes(role))
        )
    })
    return {
        passed: runs.every((run) => run.result.passed),
        runs,
        summary: {
            overallPassRate: ratio(
                runs.filter((run) => run.result.passed).length,
                runs.length
            ),
            soloOverDelegationRate: ratio(
                observed.filter(
                    (run) =>
                        run.scenario.expectedMode === 'solo' &&
                        run.observation.agentCount > 0
                ).length,
                observed.filter((run) => run.scenario.expectedMode === 'solo')
                    .length
            ),
            assistantModeAccuracy: modeAccuracy(runs, 'assistant'),
            orchestratorModeAccuracy: modeAccuracy(runs, 'orchestrator'),
            averageChildrenSpawned: ratio(
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

export interface HandoffBehaviorRun {
    readonly scenario: HandoffEvalCase
    readonly prompts: ReadonlyArray<string>
    readonly result: HandoffQualityResult
    readonly response?: string
}

export function buildHandoffBehaviorPrompt(scenario: HandoffEvalCase) {
    return `Act as the parent agent for the task below.
Use the available collaboration tools normally when delegation is useful.
Tool calls are intercepted and do not launch real child work.
Transfer the context you already know into any child handoff instead of making the child rediscover it.

Context you already know: ${scenario.parentContext}

Task: ${scenario.parentTask}

Delegate as a ${scenario.role} child when useful.`
}

async function runHandoffScenario(
    options: BehavioralDelegationOptions,
    scenario: HandoffEvalCase,
    logPath: string
): Promise<HandoffBehaviorRun> {
    const args = buildBehaviorEvalArgs(
        options,
        buildHandoffBehaviorPrompt(scenario)
    )
    let response: string | undefined
    let failure: string | undefined
    try {
        const result = await exec(options.command ?? 'pi', args, {
            cwd: options.cwd,
            env: { ...process.env, PI_SUBAGENTS_BEHAVIOR_LOG: logPath },
            timeout: options.timeoutMs ?? 120_000,
            maxBuffer: 128 * 1024,
        })
        response = result.stdout
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
    }
    const calls = readCalls(logPath)
    const prompts = spawnPrompts(calls)
    const result = failure
        ? {
              passed: false,
              failures: [failure],
              matchedSignals: [],
              coverage: 0,
          }
        : evaluateRecordedHandoffs(calls, scenario)
    return {
        scenario,
        prompts,
        result,
        ...(response !== undefined ? { response } : {}),
    }
}

/**
 * Run handoff-quality scenarios through the real parent setup. Each run
 * scores the actual recorded spawn prompt for semantic completeness, not
 * just whether delegation happened.
 */
export async function runHandoffBehaviorEvals(
    options: BehavioralDelegationOptions,
    scenarios: ReadonlyArray<HandoffEvalCase> = HANDOFF_EVALS
): Promise<{
    readonly passed: boolean
    readonly runs: ReadonlyArray<HandoffBehaviorRun>
    readonly summary: {
        readonly passRate: number
        readonly averageCoverage: number
    }
}> {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'subagents-handoff-eval-')
    )
    const runs: HandoffBehaviorRun[] = []
    try {
        for (const scenario of scenarios) {
            const logPath = path.join(directory, `${scenario.name}.jsonl`)
            runs.push(await runHandoffScenario(options, scenario, logPath))
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
    const passed = runs.every((run) => run.result.passed)
    const passRate =
        runs.length === 0
            ? 0
            : runs.filter((r) => r.result.passed).length / runs.length
    const averageCoverage =
        runs.length === 0
            ? 0
            : runs.reduce((t, r) => t + r.result.coverage, 0) / runs.length
    return { passed, runs, summary: { passRate, averageCoverage } }
}

async function main() {
    const model = process.env.PI_SUBAGENTS_EVAL_MODEL?.trim()
    if (!model) {
        console.error(
            'Set PI_SUBAGENTS_EVAL_MODEL to run the behavioral delegation evaluation.'
        )
        process.exitCode = 2
        return
    }

    const requestedNames = process.env.PI_SUBAGENTS_EVAL_CASES?.split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    const allNames = [
        ...DELEGATION_EVALS.map((s) => s.name),
        ...HANDOFF_EVALS.map((s) => s.name),
    ]
    const scenarios = requestedNames
        ? DELEGATION_EVALS.filter((scenario) =>
              requestedNames.includes(scenario.name)
          )
        : DELEGATION_EVALS
    const handoffScenarios = requestedNames
        ? HANDOFF_EVALS.filter((scenario) =>
              requestedNames.includes(scenario.name)
          )
        : HANDOFF_EVALS
    const unknownNames =
        requestedNames?.filter((name) => !allNames.includes(name)) ?? []

    if (
        scenarios.length + handoffScenarios.length === 0 ||
        unknownNames.length > 0
    ) {
        console.error(
            `Unknown or empty evaluation cases: ${[
                ...unknownNames,
                ...(scenarios.length + handoffScenarios.length === 0
                    ? (requestedNames ?? [])
                    : []),
            ].join(', ')}`
        )
        process.exitCode = 2
        return
    }

    const timeoutMs = Number.parseInt(
        process.env.PI_SUBAGENTS_EVAL_TIMEOUT_MS ?? '120000',
        10
    )
    const options = {
        model,
        command: process.env.PI_SUBAGENTS_EVAL_COMMAND,
        cwd: process.cwd(),
        timeoutMs:
            Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
    }
    const suite = await runBehavioralDelegationEvals(options, scenarios)
    const handoffSuite = await runHandoffBehaviorEvals(
        options,
        handoffScenarios
    )
    console.log(JSON.stringify({ ...suite, handoff: handoffSuite }, null, 2))
    if (!suite.passed || !handoffSuite.passed) process.exitCode = 1
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) ===
        path.resolve(fileURLToPath(import.meta.url))
)
    await main()
