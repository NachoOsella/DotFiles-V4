import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Model } from '@earendil-works/pi-ai'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { decodePiCatalog } from './catalog.ts'
import { PROVIDER_ID, ZEN_BASE_URL } from './config.ts'
import { BOOTSTRAP_MODELS } from './models.ts'
import type { SupportedZenApi } from './types.ts'

const LEGACY_CACHE_VERSION = 1
const LEGACY_FILE_NAME = 'models.json'
const MIGRATED_FILE_NAME = 'models.v1.migrated.json'

export interface LegacyMigrationData {
    models: Model<SupportedZenApi>[]
    checkedAt: number
    path: string
}

export function legacyCachePath(agentDir = getAgentDir()): string {
    return join(agentDir, 'cache', 'pi-zen-free', LEGACY_FILE_NAME)
}

export function migratedLegacyCachePath(agentDir = getAgentDir()): string {
    return join(agentDir, 'cache', 'pi-zen-free', MIGRATED_FILE_NAME)
}

/** Read version 1 of the old extension cache without changing it. */
export async function readLegacyCache(
    agentDir = getAgentDir()
): Promise<LegacyMigrationData | undefined> {
    const path = legacyCachePath(agentDir)
    let value: unknown
    try {
        value = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch {
        return undefined
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined
    const record = value as Record<string, unknown>
    if (
        record.version !== LEGACY_CACHE_VERSION ||
        !Array.isArray(record.models)
    )
        return undefined

    const refreshedAt =
        typeof record.refreshedAt === 'string'
            ? Date.parse(record.refreshedAt)
            : Number.NaN
    if (!Number.isFinite(refreshedAt)) return undefined

    try {
        const catalog = decodePiCatalog({
            models: record.models.map((model) => {
                if (
                    typeof model !== 'object' ||
                    model === null ||
                    Array.isArray(model)
                )
                    throw new Error('invalid legacy model')
                const entry = model as Record<string, unknown>
                return {
                    ...entry,
                    api: entry.api ?? 'openai-completions',
                    provider: PROVIDER_ID,
                    baseUrl: entry.baseUrl ?? ZEN_BASE_URL,
                }
            }),
        })
        for (const model of catalog.models.values()) {
            if (
                model.api !== 'openai-completions' &&
                model.api !== 'openai-responses'
            )
                throw new Error('unsupported legacy API')
            if (
                model.cost.input === undefined ||
                model.cost.output === undefined ||
                model.cost.cacheRead === undefined ||
                model.cost.cacheWrite === undefined
            )
                throw new Error('incomplete legacy cost')
        }

        // Version 1 omitted per-model API and compatibility metadata. Migrate
        // only IDs with bundled, protocol-tested definitions instead of
        // carrying guessed Chat Completions settings into native storage.
        const legacyIds = new Set(catalog.models.keys())
        const models = BOOTSTRAP_MODELS.filter((model) =>
            legacyIds.has(model.id)
        ).map((model) => structuredClone(model) as Model<SupportedZenApi>)
        if (models.length === 0) return undefined
        return { models, checkedAt: refreshedAt, path }
    } catch {
        return undefined
    }
}

/** Atomically mark the old cache as migrated after native persistence succeeds. */
export async function renameMigratedLegacyCache(
    agentDir = getAgentDir()
): Promise<boolean> {
    try {
        await rename(
            legacyCachePath(agentDir),
            migratedLegacyCachePath(agentDir)
        )
        return true
    } catch {
        return false
    }
}

/** Log startup timing only when the user explicitly enables profiling. */
export function profile(label: string, startedAt: number): void {
    if (process.env.PI_STARTUP_PROFILE !== '1') return
    const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10
    console.error(`[pi-startup] pi-zen-free ${label}: ${elapsedMs}ms`)
}
