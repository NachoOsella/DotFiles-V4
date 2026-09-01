import {
    createPiCliDelegationModel,
    DELEGATION_EVALS,
    runDelegationEvals,
} from '../delegation-evals.ts'

const model = process.env.PI_SUBAGENTS_EVAL_MODEL?.trim()
if (!model) {
    console.error(
        'Set PI_SUBAGENTS_EVAL_MODEL to run delegation evaluations against a real model.'
    )
    process.exitCode = 2
} else {
    const requestedNames = process.env.PI_SUBAGENTS_EVAL_CASES?.split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    const scenarios = requestedNames
        ? DELEGATION_EVALS.filter((scenario) =>
              requestedNames.includes(scenario.name)
          )
        : DELEGATION_EVALS
    const unknownNames =
        requestedNames?.filter(
            (name) =>
                !DELEGATION_EVALS.some((scenario) => scenario.name === name)
        ) ?? []

    if (scenarios.length === 0 || unknownNames.length > 0) {
        console.error(
            `Unknown or empty evaluation cases: ${[
                ...unknownNames,
                ...(scenarios.length === 0 ? (requestedNames ?? []) : []),
            ].join(', ')}`
        )
        process.exitCode = 2
    } else {
        const timeoutMs = Number.parseInt(
            process.env.PI_SUBAGENTS_EVAL_TIMEOUT_MS ?? '120000',
            10
        )
        const suite = await runDelegationEvals(
            createPiCliDelegationModel({
                model,
                command: process.env.PI_SUBAGENTS_EVAL_COMMAND,
                thinking: process.env.PI_SUBAGENTS_EVAL_THINKING,
                cwd: process.cwd(),
                timeoutMs:
                    Number.isFinite(timeoutMs) && timeoutMs > 0
                        ? timeoutMs
                        : 120_000,
            }),
            scenarios
        )
        console.log(
            JSON.stringify(
                {
                    passed: suite.passed,
                    runs: suite.runs.map(
                        ({ scenario, observation, result }) => ({
                            name: scenario.name,
                            expectedMode: scenario.expectedMode,
                            observation,
                            ...result,
                        })
                    ),
                },
                null,
                2
            )
        )
        if (!suite.passed) process.exitCode = 1
    }
}
