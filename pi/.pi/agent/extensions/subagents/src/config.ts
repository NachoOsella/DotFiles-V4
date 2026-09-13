/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/protocol/src/config_types.rs (MultiAgentMode)
 * core resolved V2 settings (limits, hints, wait values)
 */

import type { AgentRole } from './roles.ts'

export interface CodexSubagentsConfig {
    readonly enabled: boolean
    /** Maximum logical child identities in one root tree. */
    readonly maxAgents: number
    /** Maximum child runs executing at the same time. */
    readonly maxConcurrentExecutions: number
    /** Maximum loaded child AgentSessions. */
    readonly maxLoadedAgents: number
    /** Maximum nesting depth below /root. */
    readonly maxDepth: number
    /** Legacy names retained for settings migration. */
    readonly maxConcurrentAgents: number
    readonly maxResidentAgents: number
    readonly waitAgentEnabled: boolean
    readonly wait: {
        readonly defaultTimeoutMs: number
        readonly minTimeoutMs: number
        readonly maxTimeoutMs: number
    }
    readonly minWaitTimeoutMs: number
    readonly defaultWaitTimeoutMs: number
    readonly maxWaitTimeoutMs: number
    readonly rootAgentUsageHintText?: string
    readonly subagentUsageHintText?: string
    readonly multiAgentModeHintText?: string
    readonly subagentDeveloperInstructions?: string
    readonly exposeSpawnAgentModelOverrides: boolean
    readonly hideSpawnAgentMetadata: boolean
    readonly mode: 'auto' | 'explicit' | 'proactive'
    readonly proactiveAt:
        'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    readonly roles: Record<string, AgentRole>
}

export const DEFAULT_SUBAGENTS_CONFIG: CodexSubagentsConfig = {
    enabled: true,
    maxAgents: 6,
    maxConcurrentExecutions: 4,
    maxLoadedAgents: 16,
    maxDepth: 1,
    maxConcurrentAgents: 4,
    maxResidentAgents: 16,
    waitAgentEnabled: true,
    wait: {
        defaultTimeoutMs: 30_000,
        minTimeoutMs: 10_000,
        maxTimeoutMs: 3_600_000,
    },
    minWaitTimeoutMs: 1_000,
    defaultWaitTimeoutMs: 60_000,
    maxWaitTimeoutMs: 300_000,
    exposeSpawnAgentModelOverrides: true,
    hideSpawnAgentMetadata: false,
    mode: 'auto',
    proactiveAt: 'max',
    roles: {},
}

export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ConfigValidationError'
    }
}

/** Decode and validate raw config (e.g. from settings.json). */
export function decodeConfig(input: unknown): CodexSubagentsConfig {
    const base = { ...DEFAULT_SUBAGENTS_CONFIG }
    if (input === undefined || input === null) return base
    if (typeof input !== 'object') {
        throw new ConfigValidationError('subagents config must be an object')
    }
    const raw = input as Record<string, unknown>
    const out: CodexSubagentsConfig = { ...base }

    const asBool = (v: unknown, name: string): boolean => {
        if (typeof v !== 'boolean') {
            throw new ConfigValidationError(`${name} must be a boolean`)
        }
        return v
    }
    const asCount = (v: unknown, name: string): number => {
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
            throw new ConfigValidationError(`${name} must be an integer >= 1`)
        }
        return v
    }
    const asMs = (v: unknown, name: string): number => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new ConfigValidationError(`${name} must be a finite ms >= 0`)
        }
        return Math.floor(v)
    }
    const asOptionalText = (v: unknown, name: string): string | undefined => {
        if (v === undefined) return undefined
        if (typeof v !== 'string') {
            throw new ConfigValidationError(`${name} must be a string`)
        }
        return v
    }

    if (raw.enabled !== undefined) {
        ;(out as { enabled: boolean }).enabled = asBool(raw.enabled, 'enabled')
    }
    if (raw.maxAgents !== undefined) {
        ;(out as { maxAgents: number }).maxAgents = asCount(
            raw.maxAgents,
            'maxAgents'
        )
    }
    if (raw.maxConcurrentExecutions !== undefined) {
        ;(out as { maxConcurrentExecutions: number }).maxConcurrentExecutions =
            asCount(raw.maxConcurrentExecutions, 'maxConcurrentExecutions')
    }
    if (raw.maxLoadedAgents !== undefined) {
        ;(out as { maxLoadedAgents: number }).maxLoadedAgents = asCount(
            raw.maxLoadedAgents,
            'maxLoadedAgents'
        )
    }
    if (raw.maxDepth !== undefined) {
        if (
            typeof raw.maxDepth !== 'number' ||
            !Number.isSafeInteger(raw.maxDepth) ||
            raw.maxDepth < 0
        ) {
            throw new ConfigValidationError('maxDepth must be an integer >= 0')
        }
        ;(out as { maxDepth: number }).maxDepth = raw.maxDepth
    }
    if (raw.maxConcurrentAgents !== undefined) {
        ;(out as { maxConcurrentAgents: number }).maxConcurrentAgents = asCount(
            raw.maxConcurrentAgents,
            'maxConcurrentAgents'
        )
        ;(out as { maxConcurrentExecutions: number }).maxConcurrentExecutions =
            out.maxConcurrentAgents
    }
    if (raw.maxResidentAgents !== undefined) {
        ;(out as { maxResidentAgents: number }).maxResidentAgents = asCount(
            raw.maxResidentAgents,
            'maxResidentAgents'
        )
        ;(out as { maxLoadedAgents: number }).maxLoadedAgents =
            out.maxResidentAgents
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
        ;(out as { wait: CodexSubagentsConfig['wait'] }).wait = {
            defaultTimeoutMs,
            minTimeoutMs,
            maxTimeoutMs,
        }
    }
    if (raw.waitAgentEnabled !== undefined) {
        ;(out as { waitAgentEnabled: boolean }).waitAgentEnabled = asBool(
            raw.waitAgentEnabled,
            'waitAgentEnabled'
        )
    }
    if (raw.minWaitTimeoutMs !== undefined) {
        ;(out as { minWaitTimeoutMs: number }).minWaitTimeoutMs = asMs(
            raw.minWaitTimeoutMs,
            'minWaitTimeoutMs'
        )
    }
    if (raw.defaultWaitTimeoutMs !== undefined) {
        ;(out as { defaultWaitTimeoutMs: number }).defaultWaitTimeoutMs = asMs(
            raw.defaultWaitTimeoutMs,
            'defaultWaitTimeoutMs'
        )
    }
    if (raw.maxWaitTimeoutMs !== undefined) {
        ;(out as { maxWaitTimeoutMs: number }).maxWaitTimeoutMs = asMs(
            raw.maxWaitTimeoutMs,
            'maxWaitTimeoutMs'
        )
    }
    if (
        out.minWaitTimeoutMs > out.defaultWaitTimeoutMs ||
        out.defaultWaitTimeoutMs > out.maxWaitTimeoutMs
    ) {
        throw new ConfigValidationError(
            'require minWaitTimeoutMs <= defaultWaitTimeoutMs <= maxWaitTimeoutMs'
        )
    }
    const rootHint = asOptionalText(
        raw.rootAgentUsageHintText,
        'rootAgentUsageHintText'
    )
    const subHint = asOptionalText(
        raw.subagentUsageHintText,
        'subagentUsageHintText'
    )
    const modeHint = asOptionalText(
        raw.multiAgentModeHintText,
        'multiAgentModeHintText'
    )
    const devInstructions = asOptionalText(
        raw.subagentDeveloperInstructions,
        'subagentDeveloperInstructions'
    )
    if (rootHint !== undefined) {
        ;(out as { rootAgentUsageHintText?: string }).rootAgentUsageHintText =
            rootHint
    }
    if (subHint !== undefined) {
        ;(out as { subagentUsageHintText?: string }).subagentUsageHintText =
            subHint
    }
    if (modeHint !== undefined) {
        ;(out as { multiAgentModeHintText?: string }).multiAgentModeHintText =
            modeHint
    }
    if (devInstructions !== undefined) {
        ;(
            out as { subagentDeveloperInstructions?: string }
        ).subagentDeveloperInstructions = devInstructions
    }
    if (raw.exposeSpawnAgentModelOverrides !== undefined) {
        ;(
            out as { exposeSpawnAgentModelOverrides: boolean }
        ).exposeSpawnAgentModelOverrides = asBool(
            raw.exposeSpawnAgentModelOverrides,
            'exposeSpawnAgentModelOverrides'
        )
    }
    if (raw.hideSpawnAgentMetadata !== undefined) {
        ;(out as { hideSpawnAgentMetadata: boolean }).hideSpawnAgentMetadata =
            asBool(raw.hideSpawnAgentMetadata, 'hideSpawnAgentMetadata')
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
        ;(out as { mode: CodexSubagentsConfig['mode'] }).mode = raw.mode
    }
    if (raw.roles !== undefined) {
        if (
            typeof raw.roles !== 'object' ||
            raw.roles === null ||
            Array.isArray(raw.roles)
        ) {
            throw new ConfigValidationError('roles must be an object')
        }
        const roles: Record<string, AgentRole> = {}
        for (const [name, value] of Object.entries(raw.roles)) {
            if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
                throw new ConfigValidationError(`invalid role name "${name}"`)
            }
            if (
                typeof value !== 'object' ||
                value === null ||
                Array.isArray(value)
            ) {
                throw new ConfigValidationError(
                    `role "${name}" must be an object`
                )
            }
            const role = value as Record<string, unknown>
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
                (typeof role.thinkingLevel !== 'string' ||
                    ![
                        'off',
                        'minimal',
                        'low',
                        'medium',
                        'high',
                        'xhigh',
                        'max',
                    ].includes(role.thinkingLevel))
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
                ...(typeof role.model === 'string'
                    ? { model: role.model }
                    : {}),
                ...(typeof role.thinkingLevel === 'string'
                    ? {
                          thinkingLevel:
                              role.thinkingLevel as AgentRole['thinkingLevel'],
                      }
                    : {}),
                ...(Array.isArray(role.tools)
                    ? { tools: role.tools as string[] }
                    : {}),
            }
        }
        ;(out as { roles: Record<string, AgentRole> }).roles = roles
    }
    if (raw.proactiveAt !== undefined) {
        const levels = [
            'off',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]
        if (
            typeof raw.proactiveAt !== 'string' ||
            !levels.includes(raw.proactiveAt)
        ) {
            throw new ConfigValidationError(
                'proactiveAt is not a valid thinking level'
            )
        }
        ;(
            out as { proactiveAt: CodexSubagentsConfig['proactiveAt'] }
        ).proactiveAt = raw.proactiveAt as CodexSubagentsConfig['proactiveAt']
    }
    return out
}

/** Clamp a requested legacy wait timeout; returns the effective value + note. */
export function clampWaitTimeout(
    config: CodexSubagentsConfig,
    requestedMs: number | undefined
): { effectiveMs: number; note: string | null; rejected: string | null } {
    const requested = requestedMs ?? config.defaultWaitTimeoutMs
    if (!Number.isFinite(requested) || requested < 0) {
        return {
            effectiveMs: config.defaultWaitTimeoutMs,
            note: null,
            rejected: 'timeout_ms must be a finite number >= 0.',
        }
    }
    if (requested > config.maxWaitTimeoutMs) {
        return {
            effectiveMs: config.maxWaitTimeoutMs,
            note: null,
            rejected: `timeout_ms exceeds maxWaitTimeoutMs (${config.maxWaitTimeoutMs}).`,
        }
    }
    if (requested < config.minWaitTimeoutMs) {
        return {
            effectiveMs: config.minWaitTimeoutMs,
            note: `Requested timeout below minimum; clamped to ${config.minWaitTimeoutMs}ms.`,
            rejected: null,
        }
    }
    return { effectiveMs: Math.floor(requested), note: null, rejected: null }
}

/** Codex-like V3 wait bounds: default 30s, minimum 10s, maximum 1h. */
export function clampV3WaitTimeout(
    config: CodexSubagentsConfig,
    requestedMs: number | undefined
): { effectiveMs: number; note: string | null; rejected: string | null } {
    const requested = requestedMs ?? config.wait.defaultTimeoutMs
    if (!Number.isFinite(requested) || requested < 0) {
        return {
            effectiveMs: config.wait.defaultTimeoutMs,
            note: null,
            rejected: 'timeout_ms must be a finite number >= 0.',
        }
    }
    if (requested > config.wait.maxTimeoutMs) {
        return {
            effectiveMs: config.wait.maxTimeoutMs,
            note: null,
            rejected: `timeout_ms exceeds maxWaitTimeoutMs (${config.wait.maxTimeoutMs}).`,
        }
    }
    if (requested < config.wait.minTimeoutMs) {
        return {
            effectiveMs: config.wait.minTimeoutMs,
            note: `Requested timeout below minimum; clamped to ${config.wait.minTimeoutMs}ms.`,
            rejected: null,
        }
    }
    return { effectiveMs: Math.floor(requested), note: null, rejected: null }
}
