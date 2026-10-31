import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
    ConfigValidationError,
    decodeConfig,
    DEFAULT_SUBAGENTS_CONFIG,
} from './config.ts'

/** Resolve explicit configuration without silently enabling unsafe defaults. */
export function loadSubagentsConfig(
    env: NodeJS.ProcessEnv = process.env
): typeof DEFAULT_SUBAGENTS_CONFIG {
    if (env.SUBAGENTS_DISABLED === '1') {
        return { ...DEFAULT_SUBAGENTS_CONFIG, enabled: false }
    }
    let config = decodeConfig(readConfiguredConfig(env))
    const counts = [
        ['SUBAGENTS_MAX_CONCURRENT', 'maxConcurrentExecutions', 1],
        ['SUBAGENTS_MAX_AGENTS', 'maxAgents', 1],
        ['SUBAGENTS_MAX_DEPTH', 'maxDepth', 0],
        ['SUBAGENTS_MAX_LOADED', 'maxLoadedAgents', 1],
    ] as const
    for (const [variable, key, minimum] of counts) {
        const raw = env[variable]
        if (raw === undefined) continue
        const value = Number(raw.trim())
        if (
            !/^\d+$/.test(raw.trim()) ||
            !Number.isSafeInteger(value) ||
            value < minimum
        ) {
            throw new ConfigValidationError(
                `${variable} must be an integer >= ${minimum}.`
            )
        }
        config = { ...config, [key]: value }
    }
    if (env.SUBAGENTS_DISABLE_WAIT === '1') {
        config = { ...config, waitAgentEnabled: false }
    }
    return config
}

function readConfiguredConfig(env: NodeJS.ProcessEnv): unknown {
    if (env.SUBAGENTS_CONFIG !== undefined) {
        return explicitConfig(
            parseConfigJson(env.SUBAGENTS_CONFIG, 'SUBAGENTS_CONFIG')
        )
    }
    const explicitPath = env.SUBAGENTS_CONFIG_PATH
    const path = explicitPath ?? join(getAgentDir(), 'settings.json')
    let text: string
    try {
        text = readFileSync(path, 'utf8')
    } catch (error) {
        if (
            explicitPath === undefined &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
            return undefined
        }
        throw new ConfigValidationError(
            `Cannot read subagent configuration at ${path}.`
        )
    }
    const settings = parseConfigJson(text, path)
    return explicitPath !== undefined
        ? explicitConfig(settings)
        : selectSubagentsConfig(settings)
}

function parseConfigJson(text: string, source: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        throw new ConfigValidationError(`Invalid JSON in ${source}.`)
    }
}

function explicitConfig(value: unknown): unknown {
    return typeof value === 'object' && value !== null && 'subagents' in value
        ? selectSubagentsConfig(value)
        : value
}

function selectSubagentsConfig(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>).subagents
}
