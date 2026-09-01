import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DELEGATION_EVALS,
    evaluateDelegation,
    parseDelegationObservation,
    runDelegationEvals,
} from './delegation-evals.ts'

test('delegation evals cover solo, assistant, and orchestrator behavior', () => {
    assert.equal(DELEGATION_EVALS.length, 20)
    assert.ok(DELEGATION_EVALS.some((item) => item.expectedMode === 'solo'))
    assert.ok(
        DELEGATION_EVALS.some((item) => item.expectedMode === 'assistant')
    )
    assert.ok(
        DELEGATION_EVALS.some((item) => item.expectedMode === 'orchestrator')
    )

    for (const item of DELEGATION_EVALS) {
        assert.ok(item.prompt.length > 0)
        assert.ok(item.name.length > 0)
        assert.ok(item.expectedAgentRange[0] <= item.expectedAgentRange[1])
        if (item.expectedMode === 'solo')
            assert.deepEqual(item.expectedAgentRange, [0, 0])
    }
})

test('delegation evals score observed traces and reject over-delegation', () => {
    const solo = DELEGATION_EVALS.find((item) => item.expectedMode === 'solo')
    assert.ok(solo)
    assert.equal(
        evaluateDelegation(solo, {
            agentCount: 0,
            roles: [],
            immediatelyWaited: false,
        }).passed,
        true
    )
    const failure = evaluateDelegation(solo, {
        agentCount: 1,
        roles: ['explorer'],
        immediatelyWaited: true,
    })
    assert.equal(failure.passed, false)
    assert.deepEqual(failure.failures, [
        'expected 0-0 agents, got 1',
        'delegation was followed by an immediate wait',
    ])
})

test('delegation evals execute through a controlled model adapter', async () => {
    const suite = await runDelegationEvals(async ({ scenario }) =>
        JSON.stringify({
            agentCount: scenario.expectedAgentRange[0],
            roles: Array.from(
                { length: scenario.expectedAgentRange[0] },
                () => scenario.expectedRoles?.[0] ?? 'worker'
            ),
            immediatelyWaited: false,
        })
    )
    assert.equal(suite.passed, true)
    assert.equal(suite.runs.length, DELEGATION_EVALS.length)
    assert.ok(suite.runs.every((run) => run.observation !== undefined))
})

test('delegation observation parsing tolerates a JSON code fence', () => {
    assert.deepEqual(
        parseDelegationObservation(
            `
                \`\`\`json
                {"agentCount":1,"roles":["explorer"],"immediatelyWaited":false}
                \`\`\`
            `
        ),
        {
            agentCount: 1,
            roles: ['explorer'],
            immediatelyWaited: false,
        }
    )
    assert.throws(
        () => parseDelegationObservation('not a delegation decision'),
        /valid delegation JSON/
    )
})

test('delegation evals keep assistant and orchestration bounded', () => {
    for (const item of DELEGATION_EVALS) {
        if (item.expectedMode === 'assistant')
            assert.deepEqual(item.expectedAgentRange, [1, 1])
        if (item.expectedMode === 'orchestrator')
            assert.ok(item.expectedAgentRange[0] >= 2)
    }
})
