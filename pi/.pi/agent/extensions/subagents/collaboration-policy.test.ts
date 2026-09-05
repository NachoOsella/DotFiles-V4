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
    SUBAGENT_CHECK_TOOL_DESCRIPTION,
    SUBAGENT_SEND_TOOL_DESCRIPTION,
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
    SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    SUBAGENT_SPAWN_PROMPT_SNIPPET,
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
    buildMailboxMessage,
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
    assert.match(COLLABORATION_POLICY, /one bounded responsibility/)
    assert.match(
        COLLABORATION_POLICY,
        /does not have your conversation context/
    )
    assert.match(COLLABORATION_POLICY, /Do not make the child rediscover/)
    assert.match(COLLABORATION_POLICY, /what counts as done/)
    assert.match(
        COLLABORATION_POLICY,
        /Never delegate with a vague instruction/
    )
    assert.match(
        COLLABORATION_POLICY,
        /continue useful independent work instead of immediately waiting/
    )
    assert.match(
        COLLABORATION_POLICY,
        /At that synchronization point, use subagent_wait/
    )
    assert.match(COLLABORATION_POLICY, /Answer the child with subagent_send/)
    assert.match(COLLABORATION_POLICY, /Reconcile child results/)
    assert.doesNotMatch(COLLABORATION_POLICY, /cheapest capable model/)
    assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /blocking question/)
    assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /dependency boundary/)
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

test('parent prompts teach complete handoffs and synchronization', () => {
    assert.match(
        SUBAGENT_SPAWN_TOOL_DESCRIPTION,
        /does not know what the parent learned/
    )
    assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /precise handoff matters/)
    assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /Do not send vague prompts/)
    assert.match(
        SUBAGENT_SPAWN_TOOL_DESCRIPTION,
        /Synchronize with subagent_wait/
    )
    assert.match(SUBAGENT_SPAWN_PROMPT_SNIPPET, /complete handoff/)
    assert.match(
        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
        /cannot see the parent's conversation/
    )
    assert.match(
        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
        /capable smaller model/
    )
    assert.match(
        SUBAGENT_SEND_TOOL_DESCRIPTION,
        /prefer answering through this tool rather than taking over/
    )
    assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /Use steer only when/)
    assert.match(SUBAGENT_CHECK_TOOL_DESCRIPTION, /not for repeated polling/)
})

test('mailbox wording guides answers and reconciliation', () => {
    const question = buildMailboxMessage([
        {
            sequence: 1,
            agentId: 'sa-1',
            taskName: 'q',
            role: 'worker',
            kind: 'question',
            text: 'Which API?',
            createdAt: 1,
        },
    ])
    assert.match(question, /Subagent question:/)
    assert.match(question, /Answer the question through subagent_send/)
    assert.doesNotMatch(question, /Subagent updates:/)

    const result = buildMailboxMessage([
        {
            sequence: 2,
            agentId: 'sa-1',
            taskName: 'r',
            role: 'worker',
            kind: 'result',
            runId: 'run-1',
            text: 'done',
            createdAt: 2,
        },
    ])
    assert.match(result, /Subagent result:/)
    assert.match(result, /Reconcile this result/)
    assert.doesNotMatch(result, /Subagent updates:/)
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
