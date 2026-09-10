/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/protocol/src/config_types.rs (MultiAgentMode)
 * core resolved V2 settings (limits, hints, wait values)
 */

export interface CodexSubagentsConfig {
    readonly enabled: boolean
    readonly maxConcurrentAgents: number
    readonly maxResidentAgents: number
    readonly waitAgentEnabled: boolean
    readonly minWaitTimeoutMs: number
    readonly defaultWaitTimeoutMs: number
    readonly maxWaitTimeoutMs: number
    readonly rootAgentUsageHintText?: string
    readonly subagentUsageHintText?: string
    readonly multiAgentModeHintText?: string
    readonly subagentDeveloperInstructions?: string
    readonly exposeSpawnAgentModelOverrides: boolean
    readonly hideSpawnAgentMetadata: boolean
}

export const DEFAULT_SUBAGENTS_CONFIG: CodexSubagentsConfig = {
    enabled: true,
    maxConcurrentAgents: 4,
    maxResidentAgents: 16,
    waitAgentEnabled: true,
    minWaitTimeoutMs: 1_000,
    defaultWaitTimeoutMs: 60_000,
    maxWaitTimeoutMs: 300_000,
    exposeSpawnAgentModelOverrides: true,
    hideSpawnAgentMetadata: false,
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
    if (raw.maxConcurrentAgents !== undefined) {
        ;(out as { maxConcurrentAgents: number }).maxConcurrentAgents = asCount(
            raw.maxConcurrentAgents,
            'maxConcurrentAgents'
        )
    }
    if (raw.maxResidentAgents !== undefined) {
        ;(out as { maxResidentAgents: number }).maxResidentAgents = asCount(
            raw.maxResidentAgents,
            'maxResidentAgents'
        )
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
    return out
}

/** Clamp a requested wait timeout; returns the effective value + note. */
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
