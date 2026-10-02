import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const CONFIG_FIELD = 'pi-gpt-fast-mode'
const DEFAULT_SHORTCUT = 'ctrl+alt+m'
const RESERVED_SHORTCUTS = new Set(['ctrl+m', 'enter', 'return'])

function readConfig(fileName: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(
            readFileSync(join(getAgentDir(), fileName), 'utf8')
        )
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {}
    } catch {
        return {}
    }
}

export function defaultEnabled(): boolean {
    const config = readConfig('settings.json')[CONFIG_FIELD]
    return (
        config !== null &&
        typeof config === 'object' &&
        !Array.isArray(config) &&
        (config as { enabled?: unknown }).enabled === true
    )
}

export function shortcuts(): string[] {
    const value = readConfig('keybindings.json')[CONFIG_FIELD]
    if (value === false || value === null) return []
    const entries = Array.isArray(value) ? value : [value ?? DEFAULT_SHORTCUT]
    return [
        ...new Set(
            entries
                .filter((entry): entry is string => typeof entry === 'string')
                .map((entry) => entry.trim())
                .filter(
                    (entry) =>
                        entry && !RESERVED_SHORTCUTS.has(entry.toLowerCase())
                )
        ),
    ]
}
