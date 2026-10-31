import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadSubagentsConfig } from '../../index.ts'

test('explicit malformed JSON never silently enables default subagents', () => {
    assert.throws(
        () => loadSubagentsConfig({ SUBAGENTS_CONFIG: '{not-json' }),
        /Invalid JSON in SUBAGENTS_CONFIG/
    )
})

test('an explicit missing configuration file is an error', () => {
    assert.throws(
        () =>
            loadSubagentsConfig({
                SUBAGENTS_CONFIG_PATH: '/missing-subagents-config/config.json',
            }),
        /Cannot read subagent configuration/
    )
})

test('configuration file errors identify the source without echoing its contents', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-entry-config-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'config.json')
    writeFileSync(path, '{"secret":"do-not-echo", broken')
    assert.throws(
        () => loadSubagentsConfig({ SUBAGENTS_CONFIG_PATH: path }),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.match(error.message, /Invalid JSON/)
            assert.ok(error.message.includes(path))
            assert.ok(!error.message.includes('do-not-echo'))
            return true
        }
    )
})

test('environment counts reject partial integers and respect zero-depth semantics', () => {
    for (const [name, value] of [
        ['SUBAGENTS_MAX_CONCURRENT', '4junk'],
        ['SUBAGENTS_MAX_LOADED', '2.5'],
        ['SUBAGENTS_MAX_AGENTS', '0'],
        ['SUBAGENTS_MAX_DEPTH', '-1'],
    ]) {
        assert.throws(
            () =>
                loadSubagentsConfig({
                    SUBAGENTS_CONFIG: '{}',
                    [name!]: value,
                }),
            new RegExp(name!)
        )
    }
    const config = loadSubagentsConfig({
        SUBAGENTS_CONFIG: '{}',
        SUBAGENTS_MAX_CONCURRENT: '2',
        SUBAGENTS_MAX_DEPTH: '0',
        SUBAGENTS_MAX_AGENTS: '8',
        SUBAGENTS_MAX_LOADED: '3',
        SUBAGENTS_DISABLE_WAIT: '1',
    })
    assert.equal(config.maxConcurrentExecutions, 2)
    assert.equal(config.maxDepth, 0)
    assert.equal(config.maxAgents, 8)
    assert.equal(config.maxLoadedAgents, 3)
    assert.equal(config.waitAgentEnabled, false)
})

test('explicit JSON and files accept raw config or settings with a subagents section', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-entry-config-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'config.json')
    const config = { maxAgents: 9 }
    for (const value of [config, { subagents: config }]) {
        const json = JSON.stringify(value)
        assert.equal(
            loadSubagentsConfig({ SUBAGENTS_CONFIG: json }).maxAgents,
            9
        )
        writeFileSync(path, json)
        assert.equal(
            loadSubagentsConfig({ SUBAGENTS_CONFIG_PATH: path }).maxAgents,
            9
        )
    }
})

test('explicit disable wins over invalid configuration', () => {
    assert.equal(
        loadSubagentsConfig({
            SUBAGENTS_DISABLED: '1',
            SUBAGENTS_CONFIG: '{invalid',
        }).enabled,
        false
    )
})
