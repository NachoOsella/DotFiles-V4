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
    assert.match(COLLABORATION_POLICY, /work yourself/)
    assert.match(COLLABORATION_POLICY, /one bounded responsibility/)
    assert.match(COLLABORATION_POLICY, /complete handoff/)
    assert.match(COLLABORATION_POLICY, /rediscover known facts/)
    assert.match(COLLABORATION_POLICY, /vague prompt/)
    assert.match(COLLABORATION_POLICY, /continue useful independent work/)
    assert.match(COLLABORATION_POLICY, /dependency boundary/)
    assert.match(COLLABORATION_POLICY, /blocking child questions/)
    assert.match(COLLABORATION_POLICY, /Integrate and verify/)
    assert.match(COLLABORATION_POLICY, /observed validation/)
    assert.match(COLLABORATION_POLICY, /never claim unobserved success/)
    assert.match(COLLABORATION_POLICY, /Reconcile stale or conflicting/)
    assert.doesNotMatch(COLLABORATION_POLICY, /cheapest capable model/)
    assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /blocking question/)
    assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /dependent decision/)
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

test('prompt layers keep behavior, schema, and coordination guidance separate', () => {
    assert.match(COLLABORATION_POLICY, /subagent_spawn/)
    assert.match(COLLABORATION_POLICY, /subagent_wait/)
    assert.match(COLLABORATION_POLICY, /subagent_send/)
    assert.doesNotMatch(COLLABORATION_POLICY, /Use this tool/i)
    assert.doesNotMatch(
        SUBAGENT_SPAWN_TOOL_DESCRIPTION,
        /owned paths|final report/i
    )
    assert.match(
        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
        /objective|expected outcome/i
    )
    for (const signal of [
        'objective',
        'context',
        'owned paths',
        'constraints',
        'acceptance',
        'validation',
        'final-report',
    ]) {
        assert.match(
            SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
            new RegExp(signal, 'i')
        )
    }

    const universalToolDescriptions = [
        SUBAGENT_SPAWN_TOOL_DESCRIPTION,
        SUBAGENT_SEND_TOOL_DESCRIPTION,
        SUBAGENT_WAIT_TOOL_DESCRIPTION,
        SUBAGENT_CHECK_TOOL_DESCRIPTION,
    ]
    for (const description of universalToolDescriptions) {
        assert.doesNotMatch(description, /pricing|cheapest|provider\//i)
    }
})

test('parent prompts teach tool behavior and complete handoffs', () => {
    assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /bounded task/)
    assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /worthwhile/)
    assert.match(COLLABORATION_POLICY, /share the filesystem/)
    assert.match(COLLABORATION_POLICY, /parallel ownership/)
    assert.match(SUBAGENT_SPAWN_PROMPT_SNIPPET, /complete handoff/)
    assert.match(
        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
        /cannot see the parent's conversation/
    )
    assert.match(
        SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
        /known context.*findings/
    )
    assert.match(
        SUBAGENT_SEND_TOOL_DESCRIPTION,
        /follow-up.*ordinary instructions.*queued work/
    )
    assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /steer only/)
    assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /blocking questions/)
    assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /dependent decision/)
    assert.match(SUBAGENT_CHECK_TOOL_DESCRIPTION, /not routine polling/)
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

test('mailbox wording covers non-blocking child updates', () => {
    const update = buildMailboxMessage([
        {
            sequence: 3,
            agentId: 'sa-1',
            taskName: 'u',
            role: 'explorer',
            kind: 'update',
            runId: 'run-1',
            text: 'halfway',
            createdAt: 3,
        },
    ])
    assert.match(update, /Subagent update:/)
    assert.match(update, /steer/)
    assert.doesNotMatch(update, /Subagent updates:/)

    const mixed = buildMailboxMessage([
        {
            sequence: 4,
            agentId: 'sa-1',
            taskName: 'u',
            role: 'explorer',
            kind: 'update',
            runId: 'run-1',
            text: 'halfway',
            createdAt: 4,
        },
        {
            sequence: 5,
            agentId: 'sa-1',
            taskName: 'q',
            role: 'explorer',
            kind: 'question',
            text: 'Which API?',
            createdAt: 5,
        },
    ])
    assert.match(mixed, /Subagent question:/)
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
