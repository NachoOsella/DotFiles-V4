import { Buffer } from 'node:buffer'
import { relative } from 'node:path'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { LspDiagnostic } from '../types.ts'

const MAX_PER_FILE = 20
const MAX_TOTAL = 50
const MAX_MESSAGE_BYTES = 512
const MAX_OUTPUT_BYTES = 12 * 1024
const MAX_OUTPUT_LINES = 200

export type DiagnosticSeverityFilter = 'error' | 'warning' | 'all'

export interface FormattedDiagnostics {
    readonly text: string
    readonly total: number
    readonly returned: number
    readonly omitted: number
    readonly truncated: boolean
}

export function formatDiagnostics(
    items: readonly LspDiagnostic[],
    cwd: string,
    severity: DiagnosticSeverityFilter = 'error'
): FormattedDiagnostics {
    const selected = items
        .filter((item) => matchesSeverity(item.severity, severity))
        .sort(
            (left, right) =>
                left.filePath.localeCompare(right.filePath) ||
                left.range.start.line - right.range.start.line ||
                left.range.start.character - right.range.start.character
        )
    if (selected.length === 0)
        return { text: '', total: 0, returned: 0, omitted: 0, truncated: false }

    const grouped = new Map<string, LspDiagnostic[]>()
    for (const item of selected) {
        const values = grouped.get(item.filePath) ?? []
        values.push(item)
        grouped.set(item.filePath, values)
    }

    const lines: string[] = []
    let returned = 0
    let candidates = 0
    for (const [filePath, fileItems] of grouped) {
        if (candidates >= MAX_TOTAL) break
        const printable = fileItems.slice(
            0,
            Math.min(MAX_PER_FILE, MAX_TOTAL - candidates)
        )
        candidates += printable.length

        const fileLines = [
            `<diagnostics file="${truncateUtf8(singleLine(relative(cwd, filePath) || filePath), 512)}">`,
        ]
        let fileReturned = 0
        for (const item of printable) {
            const line = formatDiagnostic(item)
            const remaining = selected.length - returned - 1
            if (!fits(lines, fileLines, line, remaining)) break
            fileLines.push(line)
            fileReturned += 1
            returned += 1
        }

        if (fileReturned === 0) break
        const omittedInFile = fileItems.length - fileReturned
        const omittedLine =
            omittedInFile > 0
                ? `... ${omittedInFile} more in this file`
                : undefined
        if (
            omittedLine &&
            fits(lines, fileLines, omittedLine, selected.length - returned)
        ) {
            fileLines.push(omittedLine)
        }
        lines.push(...fileLines, '</diagnostics>')
    }

    const omitted = selected.length - returned
    if (omitted > 0) lines.push(`... ${omitted} more diagnostics total`)

    return {
        text: lines.join('\n'),
        total: selected.length,
        returned,
        omitted,
        truncated:
            omitted > 0 ||
            selected.some(
                (item) =>
                    Buffer.byteLength(diagnosticMessage(item)) >
                    MAX_MESSAGE_BYTES
            ),
    }
}

export function formatDiagnostic(item: Diagnostic): string {
    const severity =
        item.severity === 1
            ? 'ERROR'
            : item.severity === 2
              ? 'WARN'
              : item.severity === 3
                ? 'INFO'
                : 'HINT'
    const line = item.range.start.line + 1
    const character = item.range.start.character + 1
    const code =
        item.code === undefined ? '' : ` ${singleLine(String(item.code))}`
    return `${severity}${code} [${line}:${character}] ${truncateUtf8(singleLine(diagnosticMessage(item)), MAX_MESSAGE_BYTES)}`
}

function fits(
    lines: readonly string[],
    fileLines: readonly string[],
    next: string,
    omitted: number
): boolean {
    const suffix = `... ${Math.max(0, omitted)} more diagnostics total`
    const output = [...lines, ...fileLines, next, '</diagnostics>', suffix]
    const text = output.join('\n')
    return (
        text.split('\n').length <= MAX_OUTPUT_LINES &&
        Buffer.byteLength(text) <= MAX_OUTPUT_BYTES
    )
}

function singleLine(value: string): string {
    return value.replace(/\r\n|\r|\n/g, '\\n')
}

function diagnosticMessage(item: Diagnostic): string {
    return typeof item.message === 'string' ? item.message : item.message.value
}

function truncateUtf8(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value) <= maxBytes) return value
    const suffix = ' [truncated]'
    const available = Math.max(0, maxBytes - Buffer.byteLength(suffix))
    let end = value.length
    while (Buffer.byteLength(value.slice(0, end)) > available) end -= 1
    return `${value.slice(0, end)}${suffix}`
}

function matchesSeverity(
    severity: Diagnostic['severity'],
    filter: DiagnosticSeverityFilter
) {
    const value = severity ?? 1
    if (filter === 'error') return value === 1
    if (filter === 'warning') return value <= 2
    return true
}
