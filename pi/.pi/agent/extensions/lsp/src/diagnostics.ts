import { relative } from 'node:path'
import type { Diagnostic } from 'vscode-languageserver-types'
import type { LspDiagnostic } from '../types.ts'

const MAX_PER_FILE = 20
const MAX_TOTAL = 50

export function formatDiagnostics(
    items: readonly LspDiagnostic[],
    cwd: string
): string {
    const errors = items
        .filter((item) => (item.severity ?? 1) === 1)
        .sort((left, right) => left.filePath.localeCompare(right.filePath))
    if (errors.length === 0) return ''

    const grouped = new Map<string, LspDiagnostic[]>()
    for (const item of errors) {
        const values = grouped.get(item.filePath) ?? []
        if (values.length < MAX_PER_FILE) values.push(item)
        grouped.set(item.filePath, values)
    }

    const lines: string[] = []
    let total = 0
    for (const [filePath, fileItems] of grouped) {
        if (total >= MAX_TOTAL) break
        const relativePath = relative(cwd, filePath) || filePath
        lines.push(`<diagnostics file="${relativePath}">`)
        for (const item of fileItems.slice(0, MAX_TOTAL - total)) {
            lines.push(formatDiagnostic(item))
            total += 1
        }
        const omitted =
            errors.filter((candidate) => candidate.filePath === filePath)
                .length - fileItems.length
        if (omitted > 0) lines.push(`... and ${omitted} more`)
        lines.push('</diagnostics>')
    }
    if (errors.length > total)
        lines.push(`... and ${errors.length - total} more diagnostics`)
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
