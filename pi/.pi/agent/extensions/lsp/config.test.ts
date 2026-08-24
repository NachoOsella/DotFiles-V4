import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'

test('untrusted projects skip discovery and custom configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-untrusted-'))
    let discoveries = 0
    try {
        const loaded = loadConfig(root, false, {
            discoverServers: () => {
                discoveries += 1
                return {}
            },
        })
        assert.equal(discoveries, 0)
        assert.equal(loaded.config.enabled, false)
        assert.deepEqual(loaded.config.servers, {})
        assert.equal(loaded.path, undefined)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('trusted discovery detects an executable in PATH without a subprocess', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-discovery-'))
    const previousPath = process.env.PATH
    const executable = join(root, 'typescript-language-server')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    process.env.PATH = root

    try {
        const loaded = loadConfig(root, true)
        assert.ok(loaded.config.servers.typescript)
    } finally {
        process.env.PATH = previousPath
        await rm(root, { recursive: true, force: true })
    }
})
