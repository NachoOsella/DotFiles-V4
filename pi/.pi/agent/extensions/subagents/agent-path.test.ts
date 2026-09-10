import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    InvalidAgentTargetError,
    InvalidTaskNameError,
    isRootPath,
    isValidAgentPath,
    isValidTaskName,
    joinAgentPath,
    parentAgentPath,
    parseAgentPath,
    pathMatchesPrefix,
    resolveTarget,
    ROOT_PATH,
} from './src/agent-path.ts'

describe('agent paths', () => {
    it('accepts root and nested canonical paths', () => {
        assert.equal(isValidAgentPath('/root'), true)
        assert.equal(isValidAgentPath('/root/a'), true)
        assert.equal(isValidAgentPath('/root/a/b_c9'), true)
        assert.equal(ROOT_PATH, '/root')
        assert.equal(isRootPath(ROOT_PATH), true)
    })

    it('rejects empty segments and bad characters', () => {
        assert.equal(isValidAgentPath(''), false)
        assert.equal(isValidAgentPath('/root/'), false)
        assert.equal(isValidAgentPath('/root//a'), false)
        assert.equal(isValidAgentPath('/root/Has-Dash'), false)
        assert.equal(isValidAgentPath('/root/Upper'), false)
        assert.equal(isValidAgentPath('/other/a'), false)
        assert.equal(isValidTaskName('ok_1'), true)
        assert.equal(isValidTaskName('Bad'), false)
        assert.equal(isValidTaskName(''), false)
        assert.throws(
            () => parseAgentPath('/root/Bad'),
            InvalidAgentTargetError
        )
        assert.throws(
            () => joinAgentPath(ROOT_PATH, 'Bad-Name'),
            InvalidTaskNameError
        )
    })

    it('joins nested spawns and reports parents', () => {
        const child = joinAgentPath(ROOT_PATH, 'research')
        assert.equal(child, '/root/research')
        const grandchild = joinAgentPath(child, 'tests')
        assert.equal(grandchild, '/root/research/tests')
        assert.equal(parentAgentPath(grandchild), '/root/research')
        assert.equal(parentAgentPath(ROOT_PATH), null)
    })

    it('resolves relative sibling and child targets', () => {
        const from = '/root/research' as ReturnType<typeof parseAgentPath>
        // Bare name resolves as sibling under the caller's parent.
        assert.equal(
            resolveTarget(from, 'inspect_tests'),
            '/root/inspect_tests'
        )
        assert.equal(resolveTarget(ROOT_PATH, 'worker'), '/root/worker')
        // Child-relative paths resolve under the caller.
        assert.equal(
            resolveTarget(from, 'child/grandchild'),
            '/root/research/child/grandchild'
        )
        // Canonical targets pass through.
        assert.equal(resolveTarget(from, '/root/other'), '/root/other')
        assert.throws(() => resolveTarget(from, ''), InvalidAgentTargetError)
        assert.throws(
            () => resolveTarget(from, '/root/Bad'),
            InvalidAgentTargetError
        )
    })

    it('matches prefixes on segment boundaries', () => {
        const path = '/root/auth_flow' as ReturnType<typeof parseAgentPath>
        assert.equal(pathMatchesPrefix(path, ''), true)
        assert.equal(pathMatchesPrefix(path, '/root/auth_flow'), true)
        assert.equal(pathMatchesPrefix(path, '/root'), true)
        assert.equal(pathMatchesPrefix(path, '/root/auth'), false)
    })
})
