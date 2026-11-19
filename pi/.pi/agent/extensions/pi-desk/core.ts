/**
 * Pure logic for the pi-desk host bridge. No Pi imports: testable with
 * `node --test --experimental-strip-types`.
 */

// ------------------------------------------------------------------ bounded payloads

/**
 * Copies a JSON-like value with long strings clipped and long arrays cut, so a
 * status payload stays small (subagent snapshots carry final answers).
 */
export function bounded(value: unknown, maxString = 600, maxArray = 100, depth = 0): unknown {
    if (depth > 8) return undefined
    if (typeof value === 'string') {
        return value.length > maxString ? `${value.slice(0, maxString)}…` : value
    }
    if (Array.isArray(value)) {
        return value.slice(0, maxArray).map((v) => bounded(v, maxString, maxArray, depth + 1))
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value)) {
            const next = bounded(v, maxString, maxArray, depth + 1)
            if (next !== undefined) out[k] = next
        }
        return out
    }
    return value
}

// ------------------------------------------------------------------ channel forwarding

export const STATUS_PREFIX = 'pi-desk:'

/**
 * Trailing-edge throttle per channel with de-duplication. `sink` receives the
 * status key and the JSON text to send with `ctx.ui.setStatus`.
 */
export function createForwarder(
    sink: (key: string, text: string) => void,
    intervalMs = 150,
    schedule: (fn: () => void, ms: number) => unknown = setTimeout
) {
    const pending = new Map<string, unknown>()
    const last = new Map<string, string>()
    const timers = new Map<string, unknown>()
    const flush = (channel: string) => {
        timers.delete(channel)
        if (!pending.has(channel)) return
        const value = pending.get(channel)
        pending.delete(channel)
        const text = JSON.stringify({ v: 1, channel, data: bounded(value) })
        if (last.get(channel) === text) return
        last.set(channel, text)
        sink(`${STATUS_PREFIX}${channel}`, text)
    }
    return {
        push(channel: string, value: unknown) {
            pending.set(channel, value)
            if (!timers.has(channel)) timers.set(channel, schedule(() => flush(channel), intervalMs))
        },
        /** Forget de-dup state, e.g. after a session switch. */
        reset() {
            last.clear()
        },
    }
}
