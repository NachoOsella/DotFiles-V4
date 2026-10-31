import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    InvalidForkTurnsError,
    type ForkTurns,
} from '../domain/communication.ts'
import { resolveSpawnContext } from './context-policy.ts'

function assertResolved(
    actual: { fork: ForkTurns; source: string },
    fork: ForkTurns,
    source: 'request' | 'role' | 'default'
): void {
    assert.deepEqual(actual.fork, fork)
    assert.equal(actual.source, source)
}

describe('resolveSpawnContext', () => {
    it('prefers an explicit request over the role policy', () => {
        assertResolved(
            resolveSpawnContext('none', {
                context: { mode: 'lastN', turns: 4 },
            }),
            { _tag: 'None' },
            'request'
        )
        assertResolved(
            resolveSpawnContext('all', { context: { mode: 'none' } }),
            { _tag: 'All' },
            'request'
        )
        assertResolved(
            resolveSpawnContext('2', { context: { mode: 'none' } }),
            { _tag: 'LastN', turns: 2 },
            'request'
        )
    })

    it('parses the request exactly like the coordinator', () => {
        assertResolved(
            resolveSpawnContext(' 2 ', undefined),
            { _tag: 'LastN', turns: 2 },
            'request'
        )
        assertResolved(
            resolveSpawnContext(' ALL ', undefined),
            { _tag: 'All' },
            'request'
        )
        assertResolved(
            resolveSpawnContext('', undefined),
            { _tag: 'All' },
            'request'
        )
    })

    it('applies none, lastN, and inherit when the request is omitted', () => {
        assertResolved(
            resolveSpawnContext(undefined, { context: { mode: 'none' } }),
            { _tag: 'None' },
            'role'
        )
        assertResolved(
            resolveSpawnContext(undefined, {
                context: { mode: 'lastN', turns: 3 },
            }),
            { _tag: 'LastN', turns: 3 },
            'role'
        )
        // inherit is an explicit role decision that keeps the default fork.
        assertResolved(
            resolveSpawnContext(undefined, { context: { mode: 'inherit' } }),
            { _tag: 'All' },
            'role'
        )
    })

    it('uses the default full fork without a request or role policy', () => {
        assertResolved(
            resolveSpawnContext(undefined, undefined),
            { _tag: 'All' },
            'default'
        )
        assertResolved(
            resolveSpawnContext(undefined, {}),
            { _tag: 'All' },
            'default'
        )
        assertResolved(
            resolveSpawnContext(undefined, { context: undefined }),
            { _tag: 'All' },
            'default'
        )
    })

    it('rejects invalid requests instead of falling back to the role', () => {
        for (const value of ['0', '-2', 'recent', '1.5', 'all none']) {
            assert.throws(
                () => resolveSpawnContext(value, { context: { mode: 'none' } }),
                InvalidForkTurnsError,
                `expected "${value}" to be rejected`
            )
        }
    })

    it('rejects invalid programmatic role policies', () => {
        for (const context of [
            { mode: 'lastN', turns: 0 },
            { mode: 'lastN', turns: 1.5 },
            { mode: 'lastN', turns: Number.NaN },
            { mode: 'lastN' },
            { mode: 'bogus' },
        ]) {
            assert.throws(
                () =>
                    resolveSpawnContext(undefined, {
                        context: context as never,
                    }),
                /Invalid role context/
            )
        }
    })

    it('is deterministic across repeated calls', () => {
        const first = resolveSpawnContext(undefined, {
            context: { mode: 'lastN', turns: 5 },
        })
        const second = resolveSpawnContext(undefined, {
            context: { mode: 'lastN', turns: 5 },
        })
        assert.deepEqual(first, second)
    })
})
