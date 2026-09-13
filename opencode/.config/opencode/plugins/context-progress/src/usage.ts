export const BAR_WIDTH = 15
export const FILLED_SEGMENT = '█'
export const EMPTY_SEGMENT = '░'
export const HIGH_THRESHOLD = 70
export const CRITICAL_THRESHOLD = 90

export function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, Math.round(value)))
}

export function buildBar(percent: number, width: number = BAR_WIDTH): string {
    const safeWidth = Number.isFinite(width)
        ? Math.max(0, Math.floor(width))
        : BAR_WIDTH
    const filled = Math.round((clampPercent(percent) / 100) * safeWidth)
    return FILLED_SEGMENT.repeat(filled) + EMPTY_SEGMENT.repeat(safeWidth - filled)
}

interface TokenUsageLike {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown } | null | undefined
}

function positive(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : 0
}

export function totalUsage(tokens: TokenUsageLike | null | undefined): number {
    if (!tokens) return 0
    return (
        positive(tokens.input) +
        positive(tokens.output) +
        positive(tokens.reasoning) +
        positive(tokens.cache?.read) +
        positive(tokens.cache?.write)
    )
}

export function usagePercent(used: number, total: number): number {
    if (!Number.isFinite(used) || !Number.isFinite(total)) return 0
    if (total <= 0 || used <= 0) return 0
    return clampPercent((used / total) * 100)
}

export function formatFull(value: number): string {
    const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    return new Intl.NumberFormat('en-US').format(safe)
}

function trimmed(value: number): string {
    if (value >= 100) return String(Math.round(value))
    return value.toFixed(1).replace(/\.0$/, '')
}

export function formatCompact(value: number): string {
    const safe = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    if (safe >= 1_000_000) return `${trimmed(safe / 1_000_000)}M`
    if (safe >= 1000) return `${trimmed(safe / 1000)}k`
    return String(safe)
}

export function detailLine(used: number, total: number): string {
    if (Number.isFinite(total) && total > 0) {
        return `${formatCompact(used)} / ${formatCompact(total)}`
    }
    return `${formatFull(used)} tokens`
}
