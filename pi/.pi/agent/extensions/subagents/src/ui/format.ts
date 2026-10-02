/** Shared display helpers for the inspector and the transcript card. */

/** Compact token count: 1234 -> 1.2K, 1500000 -> 1.5M. */
export function formatTokens(value: number): string {
    if (!Number.isFinite(value)) return '0'
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
    return String(value)
}

/** Human duration: 900ms, 12s, 2m 3s. */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
