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

test('built-in roles have short one-sentence instructions', () => {
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
        assert.ok(role.instructions.length <= 180)
        assert.equal(role.instructions.split('.').filter(Boolean).length, 1)
    }
    assert.equal(AGENT_ROLES.explorer.readOnly, true)
    assert.equal(AGENT_ROLES.reviewer.readOnly, true)
    assert.equal(AGENT_ROLES.tester.readOnly, true)
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
        defaultModel: 'role/model',
        defaultReasoningEffort: 'high',
    }

    assert.deepEqual(
        resolveAgentExecutionOptions({
            role,
            parentModel: 'parent/model',
            parentReasoningEffort: 'low',
        }),
        { model: 'role/model', reasoningEffort: 'high' }
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
})

test('the role context file is injected once', () => {
    const original = [{ path: '/project/AGENTS.md', content: 'Project rules' }]
    const withRole = withAgentRoleContextFile(original, AGENT_ROLES.explorer)
    const repeated = withAgentRoleContextFile(withRole, AGENT_ROLES.explorer)

    assert.equal(withRole.length, 2)
    assert.equal(repeated, withRole)
    assert.deepEqual(withRole[1], {
        path: SUBAGENT_ROLE_CONTEXT_FILE_PATH,
        content: `${CHILD_BASE_POLICY}\n${AGENT_ROLES.explorer.instructions}`,
    })
    assert.equal(childPolicyForRole(AGENT_ROLES.default), CHILD_BASE_POLICY)
})
