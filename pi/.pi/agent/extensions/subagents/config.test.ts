import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSubagentConfig } from './src/config.ts'

test('subagent configuration reads limits, models, and reasoning by role', () => {
    const config = loadSubagentConfig({
        PI_SUBAGENTS_MAX_RUNNING: '3',
        PI_SUBAGENTS_MAX_TRACKED: '12',
        PI_SUBAGENTS_EXPLORER_MODEL: 'cheap/explorer',
        PI_SUBAGENTS_EXPLORER_REASONING: 'minimal',
        PI_SUBAGENTS_WORKER_MODEL: 'capable/worker',
        PI_SUBAGENTS_WORKER_REASONING: 'high',
        PI_SUBAGENTS_EXPLORER_EXTENSION_TOOLS: 'lsp, fff, lsp',
        PI_SUBAGENTS_REVIEWER_EXTENSION_TOOLS: 'safe-review',
    })

    assert.equal(config.maxRunning, 3)
    assert.equal(config.maxTracked, 12)
    assert.equal(config.roleModels.explorer, 'cheap/explorer')
    assert.equal(config.roleModels.worker, 'capable/worker')
    assert.equal(config.roleReasoningEfforts.explorer, 'minimal')
    assert.equal(config.roleReasoningEfforts.worker, 'high')
    assert.deepEqual(config.allowedExtensionTools?.explorer, ['lsp', 'fff'])
    assert.deepEqual(config.allowedExtensionTools?.reviewer, ['safe-review'])
})

test('subagent configuration rejects invalid values', () => {
    assert.throws(
        () => loadSubagentConfig({ PI_SUBAGENTS_MAX_RUNNING: '0' }),
        /positive safe integer/
    )
    assert.throws(
        () =>
            loadSubagentConfig({ PI_SUBAGENTS_EXPLORER_REASONING: 'invalid' }),
        /Invalid subagent reasoning effort/
    )
})
