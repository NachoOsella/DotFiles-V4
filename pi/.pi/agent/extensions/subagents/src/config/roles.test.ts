import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeConfig, DEFAULT_SUBAGENTS_CONFIG } from './config.ts'
import { resolveRole, resolveRoleTools } from './roles.ts'

describe('role tool resolution', () => {
    it('keeps the legacy additive tools semantics without restrictions', () => {
        const resolution = resolveRoleTools(['read', 'bash'], {
            tools: ['review_tool'],
        })
        assert.deepEqual(resolution.tools, ['read', 'bash', 'review_tool'])
        assert.deepEqual(resolution.denied, [])
        assert.equal(resolution.restricted, false)
    })

    it('treats allowTools as a filter that never adds tools', () => {
        const resolution = resolveRoleTools(['read', 'bash'], {
            tools: ['review_tool'],
            allowTools: ['read', 'review_tool', 'not_inherited'],
        })
        assert.deepEqual(resolution.tools, ['read', 'review_tool'])
        assert.equal(resolution.restricted, true)
    })

    it('lets denyTools win over allowTools and tools', () => {
        const resolution = resolveRoleTools(['read', 'bash'], {
            tools: ['review_tool'],
            allowTools: ['read', 'bash', 'review_tool'],
            denyTools: ['bash'],
        })
        assert.deepEqual(resolution.tools, ['read', 'review_tool'])
        assert.deepEqual(resolution.denied, ['bash'])
        assert.equal(resolution.restricted, true)
    })

    it('deduplicates inherited, allowed, and denied names', () => {
        const resolution = resolveRoleTools(['read', 'read', 'bash'], {
            tools: ['read', 'bash'],
            denyTools: ['bash', 'bash'],
        })
        assert.deepEqual(resolution.tools, ['read'])
        assert.deepEqual(resolution.denied, ['bash'])
    })

    it('allows none with an explicit empty allowTools', () => {
        const resolution = resolveRoleTools(['read', 'bash'], {
            allowTools: [],
        })
        assert.deepEqual(resolution.tools, [])
        assert.equal(resolution.restricted, true)
    })

    it('is idempotent and safe without a role', () => {
        const role = {
            tools: ['review_tool'],
            allowTools: ['read', 'review_tool'],
            denyTools: ['review_tool'],
        }
        const first = resolveRoleTools(['read', 'bash'], role)
        const second = resolveRoleTools(first.tools, role)
        assert.deepEqual(second.tools, first.tools)
        assert.deepEqual(second.denied, first.denied)
        assert.deepEqual(resolveRoleTools(['read'], undefined).tools, ['read'])
        assert.equal(resolveRoleTools(['read'], undefined).restricted, false)
    })
})

describe('role config decoding', () => {
    it('accepts opt-in allowTools and denyTools', () => {
        const config = decodeConfig({
            roles: {
                reviewer: {
                    description: 'Read-only review',
                    allowTools: ['read', 'grep'],
                    denyTools: [],
                },
            },
        })
        const role = resolveRole(config, 'reviewer')
        assert.deepEqual(role.allowTools, ['read', 'grep'])
        assert.deepEqual(role.denyTools, [])
        assert.equal(role.description, 'Read-only review')
    })

    it('rejects non-string tool restrictions', () => {
        assert.throws(() =>
            decodeConfig({ roles: { reviewer: { allowTools: ['read', 1] } } })
        )
        assert.throws(() =>
            decodeConfig({ roles: { reviewer: { denyTools: 'bash' } } })
        )
    })

    it('keeps unknown roles failing closed', () => {
        assert.throws(
            () => resolveRole(DEFAULT_SUBAGENTS_CONFIG, 'missing'),
            /Unknown agent_type/
        )
    })
})
