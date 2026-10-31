import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    ConfigValidationError,
    decodeConfig,
    DEFAULT_SUBAGENTS_CONFIG,
} from './config.ts'
import { resolveRole } from './roles.ts'

describe('role context decoding', () => {
    it('accepts the three modes and keeps turns only for lastN', () => {
        const config = decodeConfig({
            roles: {
                inheriting: { context: { mode: 'inherit' } },
                fresh: { context: { mode: 'none' } },
                recent: { context: { mode: 'lastN', turns: 3 } },
            },
        })
        assert.deepEqual(resolveRole(config, 'inheriting').context, {
            mode: 'inherit',
        })
        assert.deepEqual(resolveRole(config, 'fresh').context, {
            mode: 'none',
        })
        assert.deepEqual(resolveRole(config, 'recent').context, {
            mode: 'lastN',
            turns: 3,
        })
    })

    it('keeps omitted context omitted', () => {
        const config = decodeConfig({ roles: { reviewer: {} } })
        assert.equal(resolveRole(config, 'reviewer').context, undefined)
        assert.equal(
            resolveRole(DEFAULT_SUBAGENTS_CONFIG, 'default').context,
            undefined
        )
    })

    it('keeps context alongside existing role fields', () => {
        const config = decodeConfig({
            roles: {
                reviewer: {
                    description: 'Read-only review',
                    model: 'test-provider/test-model',
                    tools: ['review_tool'],
                    allowTools: ['read'],
                    denyTools: ['bash'],
                    context: { mode: 'none' },
                },
            },
        })
        const role = resolveRole(config, 'reviewer')
        assert.equal(role.description, 'Read-only review')
        assert.deepEqual(role.tools, ['review_tool'])
        assert.deepEqual(role.allowTools, ['read'])
        assert.deepEqual(role.denyTools, ['bash'])
        assert.deepEqual(role.context, { mode: 'none' })
    })

    it('rejects an invalid mode', () => {
        for (const mode of ['inherit-all', '', 1, null]) {
            assert.throws(
                () =>
                    decodeConfig({
                        roles: { reviewer: { context: { mode } } },
                    }),
                ConfigValidationError
            )
        }
        assert.throws(
            () => decodeConfig({ roles: { reviewer: { context: {} } } }),
            ConfigValidationError
        )
    })

    it('requires a positive safe integer turns value for lastN', () => {
        for (const turns of [undefined, 0, -1, 1.5, '3', null]) {
            assert.throws(
                () =>
                    decodeConfig({
                        roles: {
                            reviewer: { context: { mode: 'lastN', turns } },
                        },
                    }),
                /context\.turns must be a positive integer/
            )
        }
        assert.throws(
            () =>
                decodeConfig({
                    roles: {
                        reviewer: {
                            context: {
                                mode: 'lastN',
                                turns: Number.MAX_SAFE_INTEGER + 1,
                            },
                        },
                    },
                }),
            /positive integer/
        )
    })

    it('forbids turns for inherit and none', () => {
        for (const mode of ['inherit', 'none']) {
            assert.throws(
                () =>
                    decodeConfig({
                        roles: {
                            reviewer: { context: { mode, turns: 2 } },
                        },
                    }),
                /only allowed with mode "lastN"/
            )
        }
    })

    it('rejects a non-object context and unknown keys', () => {
        for (const context of [null, 'none', [], 3]) {
            assert.throws(
                () => decodeConfig({ roles: { reviewer: { context } } }),
                /context must be an object/
            )
        }
        assert.throws(
            () =>
                decodeConfig({
                    roles: {
                        reviewer: { context: { mode: 'none', extra: true } },
                    },
                }),
            /unknown key "extra"/
        )
    })
})
