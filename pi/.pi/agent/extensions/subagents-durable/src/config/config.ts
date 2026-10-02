import { isThinkingLevel, type AgentRole, type ThinkingLevel } from './roles.js'

export interface SubagentsConfig {
    readonly enabled: boolean
    /** Maximum logical child identities in one tree. */
    readonly maxAgents: number
    /** Maximum provider requests executing at the same time. */
    readonly maxConcurrentExecutions: number
    /** Maximum nesting depth below `/root`; a direct child is depth 0. */
    readonly maxDepth: number
    readonly waitAgentEnabled: boolean
    readonly wait: {
        readonly defaultTimeoutMs: number
        readonly minTimeoutMs: number
        readonly maxTimeoutMs: number
    }
    readonly exposeSpawnAgentModelOverrides: boolean
    readonly hideSpawnAgentMetadata: boolean
    readonly mode: 'auto' | 'explicit' | 'proactive'
    readonly proactiveAt: ThinkingLevel
    readonly roles: Record<string, AgentRole>
    readonly rootAgentUsageHintText?: string
    readonly subagentUsageHintText?: string
    readonly multiAgentModeHintText?: string
    readonly subagentDeveloperInstructions?: string
}

export const DEFAULT_CONFIG: SubagentsConfig = {
    enabled: true,
    maxAgents: 6,
    maxConcurrentExecutions: 4,
    maxDepth: 1,
    waitAgentEnabled: true,
    wait: {
        defaultTimeoutMs: 30_000,
        minTimeoutMs: 10_000,
        maxTimeoutMs: 3_600_000,
    },
    exposeSpawnAgentModelOverrides: true,
    hideSpawnAgentMetadata: false,
    mode: 'auto',
    proactiveAt: 'max',
    roles: {},
}

export class ConfigValidationError extends Error {
    readonly _tag = 'ConfigValidationError'

    constructor(message: string) {
        super(message)
        this.name = 'ConfigValidationError'
    }
}

/** Decode and validate raw config, for example `settings.json.subagents`. */
export function decodeConfig(input: unknown): SubagentsConfig {
    const base: SubagentsConfig = { ...DEFAULT_CONFIG }
    if (input === undefined || input === null) return base
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new ConfigValidationError('subagents config must be an object')
    }
    const raw = input as Record<string, unknown>
    const out: {
        -readonly [K in keyof SubagentsConfig]: SubagentsConfig[K]
    } = { ...base }

    const asBool = (value: unknown, name: string): boolean => {
        if (typeof value !== 'boolean') {
            throw new ConfigValidationError(`${name} must be a boolean`)
        }
        return value
    }
    const asCount = (value: unknown, name: string): number => {
        if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 1
        ) {
            throw new ConfigValidationError(`${name} must be an integer >= 1`)
        }
        return value
    }
    const asDepth = (value: unknown): number => {
        if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0
        ) {
            throw new ConfigValidationError('maxDepth must be an integer >= 0')
        }
        return value
    }
    const asMs = (value: unknown, name: string): number => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new ConfigValidationError(`${name} must be a finite ms >= 0`)
        }
        return Math.floor(value)
    }
    const asText = (value: unknown, name: string): string | undefined => {
        if (value === undefined) return undefined
        if (typeof value !== 'string') {
            throw new ConfigValidationError(`${name} must be a string`)
        }
        return value
    }

    if (raw.enabled !== undefined) out.enabled = asBool(raw.enabled, 'enabled')
    if (raw.maxAgents !== undefined) {
        out.maxAgents = asCount(raw.maxAgents, 'maxAgents')
    }
    if (raw.maxConcurrentExecutions !== undefined) {
        out.maxConcurrentExecutions = asCount(
            raw.maxConcurrentExecutions,
            'maxConcurrentExecutions'
        )
    }
    if (raw.maxDepth !== undefined) out.maxDepth = asDepth(raw.maxDepth)
    if (raw.waitAgentEnabled !== undefined) {
        out.waitAgentEnabled = asBool(raw.waitAgentEnabled, 'waitAgentEnabled')
    }
    if (raw.wait !== undefined) {
        if (
            typeof raw.wait !== 'object' ||
            raw.wait === null ||
            Array.isArray(raw.wait)
        ) {
            throw new ConfigValidationError('wait must be an object')
        }
        const wait = raw.wait as Record<string, unknown>
        const defaultTimeoutMs =
            wait.defaultTimeoutMs === undefined
                ? out.wait.defaultTimeoutMs
                : asMs(wait.defaultTimeoutMs, 'wait.defaultTimeoutMs')
        const minTimeoutMs =
            wait.minTimeoutMs === undefined
                ? out.wait.minTimeoutMs
                : asMs(wait.minTimeoutMs, 'wait.minTimeoutMs')
        const maxTimeoutMs =
            wait.maxTimeoutMs === undefined
                ? out.wait.maxTimeoutMs
                : asMs(wait.maxTimeoutMs, 'wait.maxTimeoutMs')
        if (
            minTimeoutMs > defaultTimeoutMs ||
            defaultTimeoutMs > maxTimeoutMs
        ) {
            throw new ConfigValidationError(
                'require wait.minTimeoutMs <= wait.defaultTimeoutMs <= wait.maxTimeoutMs'
            )
        }
        out.wait = { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs }
    }
    if (raw.exposeSpawnAgentModelOverrides !== undefined) {
        out.exposeSpawnAgentModelOverrides = asBool(
            raw.exposeSpawnAgentModelOverrides,
            'exposeSpawnAgentModelOverrides'
        )
    }
    if (raw.hideSpawnAgentMetadata !== undefined) {
        out.hideSpawnAgentMetadata = asBool(
            raw.hideSpawnAgentMetadata,
            'hideSpawnAgentMetadata'
        )
    }
    if (raw.mode !== undefined) {
        if (
            raw.mode !== 'auto' &&
            raw.mode !== 'explicit' &&
            raw.mode !== 'proactive'
        ) {
            throw new ConfigValidationError(
                'mode must be auto, explicit, or proactive'
            )
        }
        out.mode = raw.mode
    }
    if (raw.proactiveAt !== undefined) {
        if (!isThinkingLevel(raw.proactiveAt)) {
            throw new ConfigValidationError(
                'proactiveAt is not a valid thinking level'
            )
        }
        out.proactiveAt = raw.proactiveAt
    }
    if (raw.roles !== undefined) {
        out.roles = parseRoles(raw.roles)
    }

    const rootHint = asText(
        raw.rootAgentUsageHintText,
        'rootAgentUsageHintText'
    )
    const subHint = asText(raw.subagentUsageHintText, 'subagentUsageHintText')
    const modeHint = asText(
        raw.multiAgentModeHintText,
        'multiAgentModeHintText'
    )
    const devInstructions = asText(
        raw.subagentDeveloperInstructions,
        'subagentDeveloperInstructions'
    )
    if (rootHint !== undefined) out.rootAgentUsageHintText = rootHint
    if (subHint !== undefined) out.subagentUsageHintText = subHint
    if (modeHint !== undefined) out.multiAgentModeHintText = modeHint
    if (devInstructions !== undefined) {
        out.subagentDeveloperInstructions = devInstructions
    }
    return out
}

function parseRoles(value: unknown): Record<string, AgentRole> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ConfigValidationError('roles must be an object')
    }
    const roles: Record<string, AgentRole> = {}
    for (const [name, candidate] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
            throw new ConfigValidationError(`invalid role name "${name}"`)
        }
        if (
            typeof candidate !== 'object' ||
            candidate === null ||
            Array.isArray(candidate)
        ) {
            throw new ConfigValidationError(`role "${name}" must be an object`)
        }
        const role = candidate as Record<string, unknown>
        if (
            role.description !== undefined &&
            typeof role.description !== 'string'
        ) {
            throw new ConfigValidationError(
                `role "${name}" description must be a string`
            )
        }
        if (
            role.promptAppend !== undefined &&
            typeof role.promptAppend !== 'string'
        ) {
            throw new ConfigValidationError(
                `role "${name}" promptAppend must be a string`
            )
        }
        if (role.model !== undefined && typeof role.model !== 'string') {
            throw new ConfigValidationError(
                `role "${name}" model must be a string`
            )
        }
        if (
            role.thinkingLevel !== undefined &&
            !isThinkingLevel(role.thinkingLevel)
        ) {
            throw new ConfigValidationError(
                `role "${name}" thinkingLevel is invalid`
            )
        }
        if (
            role.tools !== undefined &&
            (!Array.isArray(role.tools) ||
                role.tools.some((tool) => typeof tool !== 'string'))
        ) {
            throw new ConfigValidationError(
                `role "${name}" tools must be an array of strings`
            )
        }
        roles[name] = {
            ...(typeof role.description === 'string'
                ? { description: role.description }
                : {}),
            ...(typeof role.promptAppend === 'string'
                ? { promptAppend: role.promptAppend }
                : {}),
            ...(typeof role.model === 'string' ? { model: role.model } : {}),
            ...(isThinkingLevel(role.thinkingLevel)
                ? { thinkingLevel: role.thinkingLevel }
                : {}),
            ...(Array.isArray(role.tools)
                ? { tools: role.tools as string[] }
                : {}),
        }
    }
    return roles
}

export interface ClampedWaitTimeout {
    readonly effectiveMs: number
    /** Set when the request was clamped up to the minimum. */
    readonly note?: string
    /** Set when the request is invalid or exceeds the maximum; the caller throws. */
    readonly rejected?: string
}

/** Clamp a requested wait timeout to the configured wait bounds. */
export function clampWaitTimeout(
    config: SubagentsConfig,
    requestedMs?: number
): ClampedWaitTimeout {
    const requested = requestedMs ?? config.wait.defaultTimeoutMs
    if (!Number.isFinite(requested) || requested < 0) {
        return {
            effectiveMs: config.wait.defaultTimeoutMs,
            rejected: 'timeout_ms must be a finite number >= 0.',
        }
    }
    if (requested > config.wait.maxTimeoutMs) {
        return {
            effectiveMs: config.wait.maxTimeoutMs,
            rejected: `timeout_ms exceeds wait.maxTimeoutMs (${config.wait.maxTimeoutMs}).`,
        }
    }
    if (requested < config.wait.minTimeoutMs) {
        return {
            effectiveMs: config.wait.minTimeoutMs,
            note: `Requested timeout below minimum; clamped to ${config.wait.minTimeoutMs}ms.`,
        }
    }
    return { effectiveMs: Math.floor(requested) }
}
