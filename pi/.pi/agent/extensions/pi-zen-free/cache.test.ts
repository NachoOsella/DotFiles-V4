import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
    legacyCachePath,
    migratedLegacyCachePath,
    readLegacyCache,
    renameMigratedLegacyCache,
} from './cache.ts'

function legacyModel(overrides: Record<string, unknown> = {}) {
    return {
        id: 'nemotron-3.5-lightning-free',
        name: 'Legacy Model',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16000,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
        },
        ...overrides,
    }
}

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-zen-free-'))
    try {
        await run(agentDir)
    } finally {
        await rm(agentDir, { recursive: true, force: true })
    }
}

async function writeLegacy(agentDir: string, value: unknown) {
    const path = legacyCachePath(agentDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value), 'utf8')
}

test('valid version 1 cache is read only as native migration data', async () => {
    await withAgentDir(async (agentDir) => {
        await writeLegacy(agentDir, {
            version: 1,
            refreshedAt: '2026-08-20T12:00:00.000Z',
            models: [legacyModel()],
        })
        const migration = await readLegacyCache(agentDir)
        assert.equal(migration?.models[0]?.provider, 'zen-free')
        assert.equal(migration?.models[0]?.api, 'openai-completions')
        assert.equal(migration?.models[0]?.id, 'nemotron-3.5-lightning-free')
        assert.equal(
            await readFile(legacyCachePath(agentDir), 'utf8'),
            JSON.stringify({
                version: 1,
                refreshedAt: '2026-08-20T12:00:00.000Z',
                models: [legacyModel()],
            })
        )
    })
})

test('invalid legacy version and malformed models are rejected', async () => {
    await withAgentDir(async (agentDir) => {
        await writeLegacy(agentDir, {
            version: 2,
            refreshedAt: '2026-08-20T12:00:00.000Z',
            models: [legacyModel()],
        })
        assert.equal(await readLegacyCache(agentDir), undefined)

        await writeLegacy(agentDir, {
            version: 1,
            refreshedAt: '2026-08-20T12:00:00.000Z',
            models: [legacyModel({ contextWindow: 0 })],
        })
        assert.equal(await readLegacyCache(agentDir), undefined)

        await writeLegacy(agentDir, {
            version: 1,
            refreshedAt: '2026-08-20T12:00:00.000Z',
            models: [legacyModel({ id: 'x-preview-f-free' })],
        })
        assert.equal(await readLegacyCache(agentDir), undefined)
    })
})

test('successful migration renames rather than deletes the old cache', async () => {
    await withAgentDir(async (agentDir) => {
        const value = {
            version: 1,
            refreshedAt: '2026-08-20T12:00:00.000Z',
            models: [legacyModel()],
        }
        await writeLegacy(agentDir, value)
        assert.equal(await renameMigratedLegacyCache(agentDir), true)
        assert.equal(
            JSON.parse(
                await readFile(migratedLegacyCachePath(agentDir), 'utf8')
            ).version,
            1
        )
        await assert.rejects(readFile(legacyCachePath(agentDir), 'utf8'))
    })
})
