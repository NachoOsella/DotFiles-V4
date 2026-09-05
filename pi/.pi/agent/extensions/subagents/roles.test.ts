import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AGENT_ROLE_NAMES,
    AGENT_ROLES,
    CHILD_BASE_POLICY,
    childPolicyForRole,
    isAgentRoleName,
    resolveAgentExecutionOptions,
    resolveAgentRole,
    SUBAGENT_ROLE_CONTEXT_FILE_PATH,
    withAgentRoleContextFile,
    type AgentRole,
} from './src/roles.ts'

test('built-in roles have focused instructions and expected permissions', () => {
    assert.deepEqual(AGENT_ROLE_NAMES, [
        'default',
        'explorer',
        'worker',
        'reviewer',
        'tester',
    ])

    for (const name of AGENT_ROLE_NAMES) {
        const role = AGENT_ROLES[name]
        assert.equal(role.name, name)
        assert.ok(role.instructions.length > 0)
    }
    assert.equal(AGENT_ROLES.explorer.canUseWriteTools, false)
    assert.equal(AGENT_ROLES.explorer.defaultReasoningEffort, 'minimal')
    assert.equal(AGENT_ROLES.worker.defaultReasoningEffort, 'medium')
    assert.equal(AGENT_ROLES.tester.defaultReasoningEffort, 'low')
    assert.equal(AGENT_ROLES.reviewer.canUseWriteTools, false)
    assert.equal(AGENT_ROLES.reviewer.defaultReasoningEffort, 'high')
    assert.equal(AGENT_ROLES.tester.canUseWriteTools, false)
    assert.ok(AGENT_ROLES.reviewer.instructions.includes('concurrency'))
    assert.ok(
        AGENT_ROLES.reviewer.instructions.toLowerCase().includes('shell access')
    )
    assert.ok(AGENT_ROLES.tester.instructions.includes('tests'))
    assert.ok(AGENT_ROLES.tester.instructions.includes('validation'))
    assert.match(CHILD_BASE_POLICY, /report_to_parent/)
    assert.match(
        CHILD_BASE_POLICY,
        /finish the current run rather than repeatedly polling/
    )
    assert.doesNotMatch(CHILD_BASE_POLICY, /Report them to the parent instead/)
    assert.match(
        CHILD_BASE_POLICY,
        /Use report_to_parent only when you need a specific parent decision/
    )
    assert.match(
        CHILD_BASE_POLICY,
        /Never use report_to_parent for progress updates/
    )
    assert.match(
        CHILD_BASE_POLICY,
        /Do not perform broad repository exploration/
    )
    assert.match(CHILD_BASE_POLICY, /stop investigating and act/)
    assert.match(
        CHILD_BASE_POLICY,
        /For small assignments, keep the execution correspondingly small/
    )
    assert.match(CHILD_BASE_POLICY, /Record unrelated issues/)
    assert.match(
        CHILD_BASE_POLICY,
        /When the requested work and appropriate focused validation are complete, finish/
    )
})

test('role instructions teach bounded execution and stopping rules', () => {
    assert.match(AGENT_ROLES.explorer.instructions, /Start from the context/)
    assert.match(
        AGENT_ROLES.explorer.instructions,
        /Stop investigating once you have enough evidence/
    )
    assert.match(AGENT_ROLES.worker.instructions, /smallest complete change/)
    assert.match(
        AGENT_ROLES.worker.instructions,
        /Once the definition of done is satisfied/
    )
    assert.match(
        AGENT_ROLES.worker.instructions,
        /Do not spend time rediscovering context/
    )
    assert.match(AGENT_ROLES.reviewer.instructions, /Do not manufacture issues/)
    assert.match(
        AGENT_ROLES.reviewer.instructions,
        /Collect them in the final review/
    )
    assert.match(
        AGENT_ROLES.tester.instructions,
        /Start with the smallest validation/
    )
    assert.match(
        AGENT_ROLES.tester.instructions,
        /Do not continue running broader validation/
    )
})

test('roles resolve to default and reject unknown names', () => {
    assert.equal(resolveAgentRole().name, 'default')
    assert.equal(resolveAgentRole('worker'), AGENT_ROLES.worker)
    assert.equal(isAgentRoleName('reviewer'), true)
    assert.equal(isAgentRoleName('planner'), false)
})

test('explicit execution settings override role and parent defaults', () => {
    const role: AgentRole = {
        name: 'worker',
        description: 'Test role.',
        instructions: 'Do the work.',
        defaultReasoningEffort: 'high',
    }

    assert.deepEqual(
        resolveAgentExecutionOptions({
            role,
            roleModel: 'configured/role',
            parentModel: 'parent/model',
            parentReasoningEffort: 'low',
        }),
        { model: 'configured/role', reasoningEffort: 'high' }
    )
    assert.deepEqual(
        resolveAgentExecutionOptions({
            role,
            model: 'explicit/model',
            reasoningEffort: 'max',
            parentModel: 'parent/model',
            parentReasoningEffort: 'low',
        }),
        { model: 'explicit/model', reasoningEffort: 'max' }
    )
    assert.deepEqual(
        resolveAgentExecutionOptions({
            role: AGENT_ROLES.explorer,
            parentModel: 'parent/model',
            parentReasoningEffort: 'low',
        }),
        { model: 'parent/model', reasoningEffort: 'minimal' }
    )
    assert.deepEqual(
        resolveAgentExecutionOptions({
            role: AGENT_ROLES.worker,
            parentModel: 'parent/model',
            parentReasoningEffort: 'low',
        }),
        { model: 'parent/model', reasoningEffort: 'medium' }
    )
    assert.deepEqual(
        resolveAgentExecutionOptions({
            role: AGENT_ROLES.reviewer,
            roleModel: 'configured/reviewer',
            parentModel: 'parent/model',
        }),
        { model: 'configured/reviewer', reasoningEffort: 'high' }
    )
    assert.deepEqual(
        resolveAgentExecutionOptions({ role: AGENT_ROLES.default }),
        { model: undefined, reasoningEffort: undefined }
    )
})

test('the role context file is injected once', () => {
    const original = [{ path: '/project/AGENTS.md', content: 'Project rules' }]
    const withRole = withAgentRoleContextFile(original, AGENT_ROLES.explorer)
    const repeated = withAgentRoleContextFile(withRole, AGENT_ROLES.explorer)

    assert.equal(withRole.length, 2)
    assert.equal(repeated, withRole)
    assert.deepEqual(withRole[1], {
        path: SUBAGENT_ROLE_CONTEXT_FILE_PATH,
        content: `${CHILD_BASE_POLICY}\n\nRole: ${AGENT_ROLES.explorer.instructions}`,
    })
    assert.equal(childPolicyForRole(AGENT_ROLES.default), CHILD_BASE_POLICY)
})
