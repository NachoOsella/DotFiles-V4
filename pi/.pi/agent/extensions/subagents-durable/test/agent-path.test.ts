import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ROOT_PATH,
    childDepth,
    isValidAgentPath,
    isValidTaskName,
    joinAgentPath,
    parentAgentPath,
    pathMatchesPrefix,
    resolveTarget,
} from '../src/domain/agent-path.js'

test('canonical paths accept only /root and narrow segments', () => {
    assert.equal(isValidAgentPath('/root'), true)
    assert.equal(isValidAgentPath('/root/a'), true)
    assert.equal(isValidAgentPath('/root/a/b_1'), true)
    assert.equal(isValidAgentPath('root/a'), false)
    assert.equal(isValidAgentPath('/root/'), false)
    assert.equal(isValidAgentPath('/root/a//b'), false)
    assert.equal(isValidAgentPath('/root/A'), false)
    assert.equal(isValidAgentPath('/root/a-b'), false)
    assert.equal(isValidTaskName('check_tests'), true)
    assert.equal(isValidTaskName(''), false)
    assert.equal(isValidTaskName('Check'), false)
})

test('joinAgentPath validates the segment and parent', () => {
    assert.equal(joinAgentPath(ROOT_PATH, 'worker'), '/root/worker')
    assert.equal(joinAgentPath('/root/a', 'b'), '/root/a/b')
    assert.throws(() => joinAgentPath(ROOT_PATH, 'Bad'), /Invalid task_name/)
})

test('parentAgentPath walks to /root and stops there', () => {
    assert.equal(parentAgentPath('/root/a/b'), '/root/a')
    assert.equal(parentAgentPath('/root/a'), '/root')
    assert.equal(parentAgentPath(ROOT_PATH), null)
})

test('childDepth counts segments below root', () => {
    assert.equal(childDepth(ROOT_PATH), -1)
    assert.equal(childDepth('/root/a'), 0)
    assert.equal(childDepth('/root/a/b'), 1)
    assert.equal(childDepth('/root/a/b/c'), 2)
})

test('resolveTarget handles absolute, bare, dot and parent forms', () => {
    assert.equal(resolveTarget(ROOT_PATH, '/root/a'), '/root/a')
    assert.equal(resolveTarget(ROOT_PATH, 'a'), '/root/a')
    assert.equal(resolveTarget('/root/a', 'b'), '/root/b')
    assert.equal(resolveTarget('/root/a', './child'), '/root/a/child')
    assert.equal(resolveTarget('/root/a', '../sibling'), '/root/sibling')
    assert.equal(
        resolveTarget('/root/a', 'child/grandchild'),
        '/root/a/child/grandchild'
    )
    assert.equal(resolveTarget('/root/a/b', 'child/..'), '/root/a/b')
    assert.throws(() => resolveTarget(ROOT_PATH, ''), /Invalid agent target/)
    assert.throws(
        () => resolveTarget(ROOT_PATH, './deep/child'),
        /Invalid agent target/
    )
    assert.throws(
        () => resolveTarget(ROOT_PATH, '../sibling'),
        /Invalid agent target/
    )
    assert.throws(() => resolveTarget('/root/a/b', '..'), /Invalid/)
    assert.equal(
        resolveTarget(ROOT_PATH, 'not/canonical'),
        '/root/not/canonical'
    )
    assert.throws(() => resolveTarget(ROOT_PATH, 'Bad/child'), /Invalid/)
})

test('pathMatchesPrefix is segment-aware', () => {
    assert.equal(pathMatchesPrefix('/root/a', '/root/a'), true)
    assert.equal(pathMatchesPrefix('/root/a/b', '/root/a'), true)
    assert.equal(pathMatchesPrefix('/root/ab', '/root/a'), false)
    assert.equal(pathMatchesPrefix('/root/a', ''), true)
    assert.equal(pathMatchesPrefix('/root/a', '/root/a/'), true)
})
