import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
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
    const offset = Math.min(Math.max(0, options.offset ?? 0), entries.length)
    const limit = Math.min(
        MAX_ITEMS,
        Math.max(1, options.limit ?? DEFAULT_ITEMS)
    )
    const candidates = entries.slice(offset, offset + limit)
    const items = await Promise.all(
        candidates.map((entry, index) =>
            formatEntry(entry, index, options, cwd)
        )
    )

    const emitted: string[] = []
    let itemTruncated = false
    for (const item of items) {
        const nextReturnedCount = emitted.length + 1
        const hasMore = offset + nextReturnedCount < entries.length
        const reserved = [
            heading(operation, entries.length, offset, nextReturnedCount),
            ...emitted,
            item.text,
            ...(hasMore
                ? [
                      `More results available: offset=${offset + nextReturnedCount}`,
                  ]
                : []),
        ].join('\n')

        if (reserved.length <= MAX_OUTPUT_CHARS) {
            emitted.push(item.text)
            itemTruncated ||= item.truncated
            continue
        }

        // An oversized first item must remain reachable instead of producing an
        // empty page. Reserve the heading and continuation before truncating it.
        if (emitted.length === 0) {
            const continuation =
                offset + 1 < entries.length
                    ? `More results available: offset=${offset + 1}`
                    : undefined
            const available = Math.max(
                1,
                MAX_OUTPUT_CHARS -
                    heading(operation, entries.length, offset, 1).length -
                    (continuation ? continuation.length + 2 : 1)
            )
            emitted.push(truncate(item.text, available))
            itemTruncated = true
        }
        break
    }

    const returnedCount = emitted.length
    const nextOffset = offset + returnedCount
    const hasMore = nextOffset < entries.length
    const summary = [
        heading(operation, entries.length, offset, returnedCount),
        ...emitted,
        ...(hasMore ? [`More results available: offset=${nextOffset}`] : []),
    ].join('\n')

    return {
        operation,
        summary,
        resultCount: entries.length,
        returnedCount,
        offset,
        nextOffset: hasMore ? nextOffset : undefined,
        truncated: itemTruncated || hasMore,
    }
}

function heading(
    operation: LspOperation,
    resultCount: number,
    offset: number,
    returnedCount: number
): string {
    if (resultCount === 0) return `No results found for ${operation}.`
    if (returnedCount === 0)
        return `${operation}: ${resultCount} result(s), showing none`
    return `${operation}: ${resultCount} result(s), showing ${offset + 1}-${offset + returnedCount}`
}

async function formatEntry(
    entry: Entry,
    index: number,
    options: CompactOptions,
    cwd: string
): Promise<{ text: string; truncated: boolean }> {
    const text = truncate(entry.text, MAX_ITEM_CHARS)
    let item = text
    let truncated = text.length < entry.text.length
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
            options.contextLines,
            cwd
        )
        if (snippet) item += `\n${snippet}`
    }
    return { text: item, truncated }
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
        const range = isRecord(value.range)
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
        range ??
        (location && isRecord(location.range) ? location.range : undefined)
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
    contextLines: number,
    cwd: string
): Promise<string> {
    try {
        const [workspace, target] = await Promise.all([
            realpath(resolve(cwd)),
            realpath(filePath),
        ])
        if (!isInsideWorkspace(target, workspace)) return ''
        const lines = (await readFile(target, 'utf8')).split(/\r\n|\r|\n/)
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

function isInsideWorkspace(filePath: string, workspace: string): boolean {
    const value = relative(workspace, filePath)
    return (
        value === '' ||
        (!isAbsolute(value) &&
            !value.startsWith('..\\') &&
            !value.startsWith('../') &&
            value !== '..')
    )
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value
    const suffix = ' [truncated]'
    if (maxChars <= suffix.length) return suffix.slice(0, maxChars)
    return `${value.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
