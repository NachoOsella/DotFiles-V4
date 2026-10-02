import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    ConfigValidationError,
    DEFAULT_CONFIG,
    clampWaitTimeout,
    decodeConfig,
} from '../src/config/config.js'
import { loadConfig } from '../src/config/load.js'
import { UnknownAgentTypeError, resolveRole } from '../src/config/roles.js'
import {
    assembleChildPrompt,
    assembleRootPrompt,
    modeInstructions,
    resolveConfiguredMode,
} from '../src/config/prompts.js'

test('decodeConfig returns defaults for absent input', () => {
    assert.deepEqual(decodeConfig(undefined), DEFAULT_CONFIG)
    assert.deepEqual(decodeConfig(null), DEFAULT_CONFIG)
})

test('decodeConfig validates fields and wait ordering', () => {
    const config = decodeConfig({
        maxAgents: 3,
        maxDepth: 2,
        wait: {
            defaultTimeoutMs: 5000,
            minTimeoutMs: 1000,
            maxTimeoutMs: 9000,
        },
    })
    assert.equal(config.maxAgents, 3)
    assert.equal(config.maxDepth, 2)
    assert.deepEqual(config.wait, {
        defaultTimeoutMs: 5000,
        minTimeoutMs: 1000,
        maxTimeoutMs: 9000,
    })
    assert.throws(() => decodeConfig({ maxAgents: 0 }), ConfigValidationError)
    assert.throws(() => decodeConfig({ maxDepth: -1 }), ConfigValidationError)
    assert.throws(
        () =>
            decodeConfig({
                wait: { minTimeoutMs: 9000, defaultTimeoutMs: 5000 },
            }),
        /wait.minTimeoutMs/
    )
})

test('clampWaitTimeout rejects invalid and clamps below minimum', () => {
    assert.deepEqual(clampWaitTimeout(DEFAULT_CONFIG, 60_000), {
        effectiveMs: 60_000,
    })
    assert.match(
        clampWaitTimeout(DEFAULT_CONFIG, 1).note ?? '',
        /clamped to 10000ms/
    )
    assert.match(
        clampWaitTimeout(DEFAULT_CONFIG, 9_999_999).rejected ?? '',
        /exceeds wait.maxTimeoutMs/
    )
    assert.match(
        clampWaitTimeout(DEFAULT_CONFIG, Number.NaN).rejected ?? '',
        /finite number/
    )
})

test('resolveRole defaults, resolves configured roles, and rejects unknown names', () => {
    const roles = {
        reviewer: { promptAppend: 'Review only.', model: 'test/model' },
    }
    assert.deepEqual(resolveRole({ roles }), { name: 'default' })
    assert.deepEqual(resolveRole({ roles }, 'reviewer'), {
        name: 'reviewer',
        promptAppend: 'Review only.',
        model: 'test/model',
    })
    assert.throws(
        () => resolveRole({ roles }, 'missing'),
        UnknownAgentTypeError
    )
})

test('resolveRole does not accept inherited prototype names', () => {
    assert.throws(
        () => resolveRole({ roles: {} }, 'constructor'),
        UnknownAgentTypeError
    )
    assert.throws(
        () => resolveRole({ roles: {} }, 'toString'),
        UnknownAgentTypeError
    )
    const configured = { roles: { constructor: { description: 'own key' } } }
    assert.deepEqual(resolveRole(configured, 'constructor'), {
        name: 'constructor',
        description: 'own key',
    })
})

test('mode resolution follows config and thinking level', () => {
    assert.deepEqual(resolveConfiguredMode(DEFAULT_CONFIG, 'max'), {
        kind: 'proactive',
    })
    assert.deepEqual(resolveConfiguredMode(DEFAULT_CONFIG, 'low'), {
        kind: 'explicit',
    })
    assert.deepEqual(
        resolveConfiguredMode({ ...DEFAULT_CONFIG, mode: 'explicit' }, 'max'),
        { kind: 'explicit' }
    )
    assert.deepEqual(
        resolveConfiguredMode({ ...DEFAULT_CONFIG, mode: 'proactive' }, 'off'),
        { kind: 'proactive' }
    )
})

test('modeInstructions appends configured hints without replacing bundled text', () => {
    assert.match(modeInstructions({ kind: 'explicit' }) ?? '', /explicit-only/)
    assert.match(modeInstructions({ kind: 'proactive' }) ?? '', /proactively/)
    assert.equal(modeInstructions({ kind: 'custom', hint: '  ' }), null)

    const input = {
        config: {
            ...DEFAULT_CONFIG,
            multiAgentModeHintText: 'Prefer small agents.',
        },
        mode: { kind: 'explicit' } as const,
        activeSlotCount: 4,
    }
    const prompt = assembleRootPrompt(input)
    assert.match(prompt, /explicit-only/)
    assert.match(prompt, /Prefer small agents\./)

    const child = assembleChildPrompt({
        ...input,
        role: { name: 'reviewer', promptAppend: 'Review the diff.' },
        path: '/root/reviewer',
        parentPath: '/root',
        currentDepth: 0,
    })
    assert.match(child, /Your agent path is \/root\/reviewer/)
    assert.match(child, /Review the diff\./)
    assert.match(child, /depth limit/)
})

test('loadConfig reads inline, file, settings and env overrides in order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-config-'))
    try {
        const explicit = join(directory, 'agent-config.json')
        writeFileSync(explicit, JSON.stringify({ maxAgents: 9 }))
        const settings = join(directory, 'settings.json')
        writeFileSync(
            settings,
            JSON.stringify({ subagents: { maxAgents: 7, maxDepth: 3 } })
        )

        assert.equal(loadConfig({ settingsPath: settings }).maxAgents, 7)
        assert.equal(loadConfig({ settingsPath: settings }).maxDepth, 3)
        assert.equal(
            loadConfig({ settings: { subagents: { maxAgents: 5 } } }).maxAgents,
            5
        )
        assert.equal(
            loadConfig({ env: { SUBAGENTS_CONFIG_PATH: explicit } }).maxAgents,
            9
        )
        const overridden = loadConfig({
            env: {
                SUBAGENTS_CONFIG: JSON.stringify({ maxAgents: 8 }),
                SUBAGENTS_CONFIG_PATH: explicit,
                SUBAGENTS_MAX_AGENTS: '2',
                SUBAGENTS_MAX_CONCURRENT: '3',
                SUBAGENTS_MAX_DEPTH: '4',
                SUBAGENTS_DISABLE_WAIT: '1',
            },
            settingsPath: settings,
        })
        assert.equal(overridden.maxAgents, 2)
        assert.equal(overridden.maxConcurrentExecutions, 3)
        assert.equal(overridden.maxDepth, 4)
        assert.equal(overridden.waitAgentEnabled, false)
        assert.equal(
            loadConfig({ env: { SUBAGENTS_DISABLED: '1' } }).enabled,
            false
        )
        // Obsolete MAX_LOADED is ignored, not rejected.
        assert.equal(
            loadConfig({ env: { SUBAGENTS_MAX_LOADED: '99' } }).maxAgents,
            DEFAULT_CONFIG.maxAgents
        )
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
