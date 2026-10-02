import { readFileSync } from 'node:fs'
import { decodeConfig, type SubagentsConfig } from './config.js'

export interface LoadConfigOptions {
    readonly env?: Record<string, string | undefined>
    readonly settingsPath?: string
    /** Already-parsed settings.json content. */
    readonly settings?: unknown
}

/**
 * Resolve configuration from the environment and settings, then apply
 * environment overrides. Filesystem access stays here; `decodeConfig` is pure.
 *
 * Order: `SUBAGENTS_CONFIG` JSON, then `SUBAGENTS_CONFIG_PATH` (whole file),
 * then `options.settings.subagents`, then `options.settingsPath` (settings
 * file). `SUBAGENTS_MAX_LOADED` is obsolete and ignored.
 */
export function loadConfig(options: LoadConfigOptions = {}): SubagentsConfig {
    const env = options.env ?? process.env
    return applyEnvOverrides(
        decodeConfig(readConfiguredConfig(env, options)),
        env
    )
}

function readConfiguredConfig(
    env: Record<string, string | undefined>,
    options: LoadConfigOptions
): unknown {
    const inline = env.SUBAGENTS_CONFIG
    if (inline !== undefined) return tryJson(inline)
    const explicitPath = env.SUBAGENTS_CONFIG_PATH
    if (explicitPath !== undefined) return readJsonFile(explicitPath)
    if (options.settings !== undefined) return selectSubagents(options.settings)
    if (options.settingsPath !== undefined) {
        return selectSubagents(readJsonFile(options.settingsPath))
    }
    return undefined
}

function selectSubagents(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>).subagents
}

function tryJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

function readJsonFile(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return undefined
    }
}

function applyEnvOverrides(
    config: SubagentsConfig,
    env: Record<string, string | undefined>
): SubagentsConfig {
    let next = config
    const count = (name: string, minimum: number): number | undefined => {
        const raw = env[name]
        if (raw === undefined) return undefined
        const value = Number.parseInt(raw, 10)
        return Number.isSafeInteger(value) && value >= minimum
            ? value
            : undefined
    }
    const agents = count('SUBAGENTS_MAX_AGENTS', 1)
    if (agents !== undefined) next = { ...next, maxAgents: agents }
    const concurrent = count('SUBAGENTS_MAX_CONCURRENT', 1)
    if (concurrent !== undefined) {
        next = { ...next, maxConcurrentExecutions: concurrent }
    }
    const depth = count('SUBAGENTS_MAX_DEPTH', 0)
    if (depth !== undefined) next = { ...next, maxDepth: depth }
    if (env.SUBAGENTS_DISABLE_WAIT === '1') {
        next = { ...next, waitAgentEnabled: false }
    }
    if (env.SUBAGENTS_DISABLED === '1') next = { ...next, enabled: false }
    return next
}
