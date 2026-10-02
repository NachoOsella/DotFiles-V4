/**
 * Schema declaration tests.
 *
 * These check meaningful model-facing validation behavior through the same
 * pi-ai validator Durable uses, not the incidental shape of the schema object.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxToolCall, validateToolArguments } from '@earendil-works/pi-ai'
import { DEFAULT_CONFIG, type SubagentsConfig } from '../src/config/config.js'
import { buildTools, type RuntimeDeps } from '../src/tools/index.js'
import type { JsonObject, ToolRegistration } from '@earendil-works/pi-durable'

function toolsFor(config: SubagentsConfig): Map<string, ToolRegistration> {
    const deps: RuntimeDeps = {
        config,
        submitWrite: async () => {
            throw new Error('submitWrite is not used by schema validation')
        },
    }
    return new Map(buildTools(deps).map((tool) => [tool.name, tool]))
}

function accepts(tool: ToolRegistration, args: JsonObject): boolean {
    try {
        validateToolArguments(tool, fauxToolCall(tool.name, args, { id: 'x' }))
        return true
    } catch {
        return false
    }
}

test('spawn schema closes objects and constrains names and messages', () => {
    const spawn = toolsFor(DEFAULT_CONFIG).get('spawn_agent')!
    assert.equal(accepts(spawn, { task_name: 'child', message: 'do it' }), true)
    assert.equal(accepts(spawn, { message: 'missing name' }), false)
    assert.equal(accepts(spawn, { task_name: 'Bad Name', message: 'x' }), false)
    assert.equal(accepts(spawn, { task_name: 'ok', message: '   ' }), false)
    assert.equal(
        accepts(spawn, { task_name: 'ok', message: 'x', extra: true }),
        false
    )
})

test('spawn schema hides model overrides when they are not exposed', () => {
    const tools = toolsFor({
        ...DEFAULT_CONFIG,
        exposeSpawnAgentModelOverrides: false,
    })
    const spawn = tools.get('spawn_agent')!
    assert.equal(
        accepts(spawn, { task_name: 'ok', message: 'x', model: 'a/b' }),
        false
    )
    assert.equal(
        accepts(spawn, {
            task_name: 'ok',
            message: 'x',
            reasoning_effort: 'high',
        }),
        false
    )
})

test('spawn schema enumerates configured roles only when metadata is shown', () => {
    const withRoles = toolsFor({
        ...DEFAULT_CONFIG,
        roles: { reviewer: {}, tester: {} },
    })
    const spawn = withRoles.get('spawn_agent')!
    assert.equal(
        accepts(spawn, {
            task_name: 'ok',
            message: 'x',
            agent_type: 'reviewer',
        }),
        true
    )
    assert.equal(
        accepts(spawn, { task_name: 'ok', message: 'x', agent_type: 'ghost' }),
        false
    )
    const hidden = toolsFor({
        ...DEFAULT_CONFIG,
        hideSpawnAgentMetadata: true,
        roles: { reviewer: {} },
    }).get('spawn_agent')!
    assert.equal(
        accepts(hidden, {
            task_name: 'ok',
            message: 'x',
            agent_type: 'reviewer',
        }),
        false
    )
})

test('wait schema requires an integer timeout inside the configured bounds', () => {
    const wait = toolsFor(DEFAULT_CONFIG).get('wait_agent')!
    assert.equal(accepts(wait, {}), true)
    assert.equal(accepts(wait, { timeout_ms: 10_000 }), true)
    assert.equal(accepts(wait, { timeout_ms: 1.5 }), false)
    assert.equal(accepts(wait, { timeout_ms: 5_000 }), false)
    assert.equal(accepts(wait, { timeout_ms: 10_000_000 }), false)
    assert.equal(accepts(wait, { targets: ['not a path!'] }), false)
    assert.equal(accepts(wait, { targets: ['/root/child'] }), true)
})

test('target tools reject malformed targets and empty payloads', () => {
    const tools = toolsFor(DEFAULT_CONFIG)
    const send = tools.get('send_message')!
    const followup = tools.get('followup_task')!
    const interrupt = tools.get('interrupt_agent')!
    assert.equal(accepts(send, { target: '/root/ok', message: 'x' }), true)
    assert.equal(accepts(send, { target: 'bad target', message: 'x' }), false)
    assert.equal(accepts(send, { target: '/root/ok', message: '' }), false)
    assert.equal(
        accepts(followup, { target: '/root/ok', message: 'x', mode: 'later' }),
        false
    )
    assert.equal(
        accepts(followup, {
            target: '/root/ok',
            message: 'x',
            mode: 'followUp',
        }),
        true
    )
    assert.equal(accepts(interrupt, { target: '/root/ok' }), true)
    assert.equal(accepts(interrupt, { target: 'x!' }), false)
})

test('wait_agent is omitted when disabled', () => {
    const tools = toolsFor({ ...DEFAULT_CONFIG, waitAgentEnabled: false })
    assert.equal(tools.has('wait_agent'), false)
    assert.equal(tools.size, 5)
})
