import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import type { LspOperation } from '../types.ts'

export interface CompactLspDetails {
    operation: LspOperation
    summary: string
    resultCount: number
    truncated: boolean
}

const MAX_OUTPUT_CHARS = 4_000
const MAX_ITEMS = 30
const MAX_ITEM_CHARS = 180

export function compactLspResult(
    operation: LspOperation,
    result: unknown,
    cwd: string
): CompactLspDetails {
    const entries = normalizeResult(operation, result, cwd)
    const limited = entries.slice(0, MAX_ITEMS)
    const lines = limited.map((entry) => truncate(entry, MAX_ITEM_CHARS))
    const omitted = Math.max(0, entries.length - limited.length)
    if (omitted > 0) lines.push(`... and ${omitted} more result(s)`)

    const body = lines.join('\n')
    const summary = truncate(
        entries.length === 0
            ? `No results found for ${operation}.`
            : `${operation}: ${entries.length} result(s)\n${body}`,
        MAX_OUTPUT_CHARS
    )

    return {
        operation,
        summary,
        resultCount: entries.length,
        truncated: summary.length < body.length || omitted > 0,
    }
}

function normalizeResult(
    operation: LspOperation,
    result: unknown,
    cwd: string
): string[] {
    if (operation === 'hover') return normalizeHover(result)
    if (operation === 'documentSymbols' || operation === 'workspaceSymbols') {
        return normalizeSymbols(result, cwd)
    }
    return normalizeLocations(result, cwd)
}

function normalizeLocations(result: unknown, cwd: string): string[] {
    const values = Array.isArray(result) ? result : result ? [result] : []
    return values.flatMap((value) => {
        if (!isRecord(value)) return []
        const uri = typeof value.uri === 'string' ? value.uri : undefined
        const range = isRecord(value.range) ? value.range : undefined
        if (!uri || !range) return []
        return [formatLocation(uri, range, cwd)]
    })
}

function normalizeSymbols(result: unknown, cwd: string): string[] {
    const values = Array.isArray(result) ? result : result ? [result] : []
    return values.flatMap((value) => formatSymbol(value, cwd))
}

function formatSymbol(value: unknown, cwd: string): string[] {
    if (!isRecord(value) || typeof value.name !== 'string') return []
    const range = isRecord(value.range) ? value.range : undefined
    const location = isRecord(value.location) ? value.location : undefined
    const uri =
        location && typeof location.uri === 'string' ? location.uri : undefined
    const symbolRange =
        range ??
        (location && isRecord(location.range) ? location.range : undefined)
    const position = symbolRange ? formatPosition(symbolRange) : ''
    const suffix = uri ? ` · ${formatUri(uri, cwd)}` : ''
    const line = position ? `${position}` : ''
    const result = [
        `${kindName(value.kind)} ${value.name}${line ? ` ${line}` : ''}${suffix}`,
    ]
    if (Array.isArray(value.children)) {
        for (const child of value.children)
            result.push(...formatSymbol(child, cwd).map((item) => `  ${item}`))
    }
    return result
}

function normalizeHover(result: unknown): string[] {
    if (!isRecord(result) || result.contents === undefined) return []
    return [flattenMarkup(result.contents)]
}

function formatLocation(
    uri: string,
    range: Record<string, unknown>,
    cwd: string
): string {
    return `${formatUri(uri, cwd)} ${formatPosition(range)}`
}

function formatUri(uri: string, cwd: string): string {
    try {
        const path = fileURLToPath(uri)
        return relative(cwd, path) || path
    } catch {
        return uri
    }
}

function formatPosition(range: Record<string, unknown>): string {
    const start = isRecord(range.start) ? range.start : undefined
    if (
        !start ||
        typeof start.line !== 'number' ||
        typeof start.character !== 'number'
    )
        return ''
    return `(${start.line + 1}:${start.character + 1})`
}

function flattenMarkup(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value))
        return value.map(flattenMarkup).filter(Boolean).join('\n')
    if (isRecord(value)) {
        if (typeof value.value === 'string') return value.value
        if (
            typeof value.language === 'string' &&
            typeof value.value === 'string'
        ) {
            return value.value
        }
    }
    return ''
}

function kindName(kind: unknown): string {
    const names: Record<number, string> = {
        5: 'class',
        6: 'method',
        10: 'enum',
        11: 'interface',
        12: 'function',
        13: 'var',
        14: 'const',
        23: 'struct',
    }
    return typeof kind === 'number' ? (names[kind] ?? 'symbol') : 'symbol'
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value
    return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()} ... [truncated]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
