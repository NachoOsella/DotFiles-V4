import { relative } from 'node:path'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { LspDiagnostic } from '../types.ts'

const MAX_PER_FILE = 20
const MAX_TOTAL = 50

export type DiagnosticSeverityFilter = 'error' | 'warning' | 'all'

export function formatDiagnostics(
    items: readonly LspDiagnostic[],
    cwd: string,
    severity: DiagnosticSeverityFilter = 'error'
): string {
    const selected = items
        .filter((item) => matchesSeverity(item.severity, severity))
        .sort(
            (left, right) =>
                left.filePath.localeCompare(right.filePath) ||
                left.range.start.line - right.range.start.line ||
                left.range.start.character - right.range.start.character
        )
    if (selected.length === 0) return ''

    const grouped = new Map<string, LspDiagnostic[]>()
    for (const item of selected) {
        const values = grouped.get(item.filePath) ?? []
        values.push(item)
        grouped.set(item.filePath, values)
    }

    const lines: string[] = []
    let printedTotal = 0
    for (const [filePath, fileItems] of grouped) {
        if (printedTotal >= MAX_TOTAL) break
        const printable = fileItems.slice(
            0,
            Math.min(MAX_PER_FILE, MAX_TOTAL - printedTotal)
        )
        const relativePath = relative(cwd, filePath) || filePath
        lines.push(`<diagnostics file="${relativePath}">`)
        for (const item of printable) lines.push(formatDiagnostic(item))
        const omitted = fileItems.length - printable.length
        if (omitted > 0) lines.push(`... ${omitted} more in this file`)
        lines.push('</diagnostics>')
        printedTotal += printable.length
    }
    const omittedTotal = selected.length - printedTotal
    if (omittedTotal > 0)
        lines.push(`... ${omittedTotal} more diagnostics total`)
    return lines.join('\n')
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
    const code = item.code === undefined ? '' : ` ${String(item.code)}`
    return `${severity}${code} [${line}:${character}] ${item.message}`
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
