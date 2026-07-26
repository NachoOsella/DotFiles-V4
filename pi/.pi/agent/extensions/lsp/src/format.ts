import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LspOperation } from '../types.ts'

export interface CompactLspDetails {
    operation: LspOperation
    summary: string
    resultCount: number
    returnedCount: number
    offset: number
    nextOffset?: number
    truncated: boolean
}

export interface CompactOptions {
    limit?: number
    offset?: number
    contextLines?: number
}

interface Entry {
    text: string
    filePath?: string
    line?: number
}

const MAX_OUTPUT_CHARS = 3_000
const DEFAULT_ITEMS = 20
const MAX_ITEMS = 50
const MAX_ITEM_CHARS = 180
const MAX_SNIPPET_RESULTS = 8

export async function compactLspResult(
    operation: LspOperation,
    result: unknown,
    cwd: string,
    options: CompactOptions = {}
): Promise<CompactLspDetails> {
    const entries = normalizeResult(operation, result, cwd)
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.min(MAX_ITEMS, Math.max(1, options.limit ?? DEFAULT_ITEMS))
    const page = entries.slice(offset, offset + limit)
    const lines: string[] = []
    let itemTruncated = false
    for (const [index, entry] of page.entries()) {
        if (entry.text.length > MAX_ITEM_CHARS) itemTruncated = true
        lines.push(truncate(entry.text, MAX_ITEM_CHARS))
        if (
            options.contextLines &&
            options.contextLines > 0 &&
            index < MAX_SNIPPET_RESULTS &&
            entry.filePath !== undefined &&
            entry.line !== undefined
        ) {
            const snippet = await sourceSnippet(
                entry.filePath,
                entry.line,
                options.contextLines
            )
            if (snippet) lines.push(snippet)
        }
    }

    const nextOffset = offset + page.length
    const hasMore = nextOffset < entries.length
    if (hasMore) lines.push(`More results available: offset=${nextOffset}`)
    const heading =
        entries.length === 0
            ? `No results found for ${operation}.`
            : `${operation}: ${entries.length} result(s), showing ${offset + 1}-${offset + page.length}`
    const rawSummary = entries.length === 0 ? heading : `${heading}\n${lines.join('\n')}`
    const summary = truncate(rawSummary, MAX_OUTPUT_CHARS)

    return {
        operation,
        summary,
        resultCount: entries.length,
        returnedCount: page.length,
        offset,
        nextOffset: hasMore ? nextOffset : undefined,
        truncated:
            itemTruncated || hasMore || summary.length < rawSummary.length,
    }
}

function normalizeResult(
    operation: LspOperation,
    result: unknown,
    cwd: string
): Entry[] {
    if (operation === 'hover') return normalizeHover(result)
    if (operation === 'documentSymbols' || operation === 'workspaceSymbols')
        return normalizeSymbols(result, cwd)
    return normalizeLocations(result, cwd)
}

function normalizeLocations(result: unknown, cwd: string): Entry[] {
    const values = Array.isArray(result) ? result : result ? [result] : []
    return values.flatMap((value) => {
        if (!isRecord(value)) return []
        const uri =
            typeof value.uri === 'string'
                ? value.uri
                : typeof value.targetUri === 'string'
                  ? value.targetUri
                  : undefined
        const range =
            isRecord(value.range)
                ? value.range
                : isRecord(value.targetSelectionRange)
                  ? value.targetSelectionRange
                  : isRecord(value.targetRange)
                    ? value.targetRange
                    : undefined
        if (!uri || !range) return []
        const position = positionFromRange(range)
        return [
            {
                text: `${formatUri(uri, cwd)} ${formatPosition(range)}`,
                filePath: filePathFromUri(uri),
                line: position?.line,
            },
        ]
    })
}

function normalizeSymbols(result: unknown, cwd: string): Entry[] {
    const values = Array.isArray(result) ? result : result ? [result] : []
    return values.flatMap((value) => formatSymbol(value, cwd))
}

function formatSymbol(value: unknown, cwd: string, depth = 0): Entry[] {
    if (!isRecord(value) || typeof value.name !== 'string') return []
    const range = isRecord(value.range) ? value.range : undefined
    const location = isRecord(value.location) ? value.location : undefined
    const uri =
        location && typeof location.uri === 'string' ? location.uri : undefined
    const symbolRange =
        range ?? (location && isRecord(location.range) ? location.range : undefined)
    const position = symbolRange ? formatPosition(symbolRange) : ''
    const suffix = uri ? ` - ${formatUri(uri, cwd)}` : ''
    const entry: Entry = {
        text: `${'  '.repeat(depth)}${kindName(value.kind)} ${value.name}${position ? ` ${position}` : ''}${suffix}`,
        filePath: uri ? filePathFromUri(uri) : undefined,
        line: symbolRange ? positionFromRange(symbolRange)?.line : undefined,
    }
    const children = Array.isArray(value.children)
        ? value.children.flatMap((child) => formatSymbol(child, cwd, depth + 1))
        : []
    return [entry, ...children]
}

function normalizeHover(result: unknown): Entry[] {
    if (!isRecord(result) || result.contents === undefined) return []
    const value = flattenMarkup(result.contents).trim()
    return value ? [{ text: value }] : []
}

function formatUri(uri: string, cwd: string): string {
    const path = filePathFromUri(uri)
    return path ? relative(cwd, path) || path : uri
}

function filePathFromUri(uri: string): string | undefined {
    try {
        return fileURLToPath(uri)
    } catch {
        return undefined
    }
}

function positionFromRange(range: Record<string, unknown>) {
    const start = isRecord(range.start) ? range.start : undefined
    if (
        !start ||
        typeof start.line !== 'number' ||
        typeof start.character !== 'number'
    )
        return undefined
    return { line: start.line, character: start.character }
}

function formatPosition(range: Record<string, unknown>): string {
    const start = positionFromRange(range)
    return start ? `(${start.line + 1}:${start.character + 1})` : ''
}

function flattenMarkup(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value))
        return value.map(flattenMarkup).filter(Boolean).join('\n')
    if (isRecord(value) && typeof value.value === 'string') return value.value
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

async function sourceSnippet(
    filePath: string,
    line: number,
    contextLines: number
): Promise<string> {
    try {
        const lines = (await readFile(filePath, 'utf8')).split(/\r\n|\r|\n/)
        const start = Math.max(0, line - contextLines)
        const end = Math.min(lines.length, line + contextLines + 1)
        return lines
            .slice(start, end)
            .map((text, index) => {
                const lineNumber = start + index + 1
                const marker = start + index === line ? '>' : ' '
                return `  ${marker}${lineNumber}: ${truncate(text, 140)}`
            })
            .join('\n')
    } catch {
        return ''
    }
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value
    return `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()} [truncated]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
