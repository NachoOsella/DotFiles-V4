import assert from 'node:assert/strict'
import test from 'node:test'
import {
    COLLABORATION_POLICY,
    collaborationPolicyForTools,
    hasCollaborationPolicy,
    isSubagentOrchestrationTool,
    SUBAGENT_ORCHESTRATION_TOOL_NAMES,
} from './src/collaboration-policy.ts'
import {
    buildSubagentSpawnResult,
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
    SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from './src/prompt.ts'

test('the collaboration policy appears only when spawning is available', () => {
    assert.equal(collaborationPolicyForTools([]), undefined)
    assert.equal(collaborationPolicyForTools(['subagent_wait']), undefined)
    assert.equal(hasCollaborationPolicy(['subagent_spawn']), true)
    assert.equal(
        collaborationPolicyForTools(['bash', 'subagent_spawn']),
        COLLABORATION_POLICY
    )
    assert.deepEqual(SUBAGENT_SPAWN_PROMPT_GUIDELINES, [COLLABORATION_POLICY])
    assert.match(COLLABORATION_POLICY, /Default to doing the work yourself/)
    assert.match(COLLABORATION_POLICY, /one bounded assistant/)
    assert.doesNotMatch(COLLABORATION_POLICY, /cheapest capable model/)
    assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /asks a question/)
    assert.match(
        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        /configured role effort, role default, or parent effort/
    )
})

test('the orchestration tool set is identifiable for child filtering', () => {
    for (const tool of SUBAGENT_ORCHESTRATION_TOOL_NAMES) {
        assert.equal(isSubagentOrchestrationTool(tool), true)
    }
    assert.equal(isSubagentOrchestrationTool('bash'), false)
})

test('spawn results do not repeat delegated prompts', () => {
    const secretPrompt = 'Implement payment flow using token: secret-value'
    const result = buildSubagentSpawnResult({
        id: 'sa-1',
        title: 'payments',
        modelLabel: 'provider/model',
        prompt: secretPrompt,
    })

    assert.match(result, /^Spawned sa-1 "payments" \(provider\/model\)\./)
    assert.doesNotMatch(result, /secret-value|payment flow|Prompt:/)
})
