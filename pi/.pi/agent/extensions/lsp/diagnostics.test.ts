import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { formatDiagnostic, formatDiagnostics } from './src/diagnostics.ts'
import type { LspDiagnostic } from './types.ts'

const diagnostic = (severity: 1 | 2, filePath: string): LspDiagnostic => ({
    filePath,
    serverId: 'test',
    severity,
    message: 'Type error',
    range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 4 },
    },
})

test('formats errors and excludes warnings', () => {
    const output = formatDiagnostics(
        [
            diagnostic(1, '/workspace/src/app.ts'),
            diagnostic(2, '/workspace/src/app.ts'),
        ],
        '/workspace'
    )

    assert.match(output.text, /<diagnostics file="src\/app\.ts">/)
    assert.match(output.text, /ERROR \[2:3\] Type error/)
    assert.doesNotMatch(output.text, /WARN/)
    assert.deepEqual(
        {
            total: output.total,
            returned: output.returned,
            omitted: output.omitted,
        },
        { total: 1, returned: 1, omitted: 0 }
    )
})

test('reports accurate omission counts across per-file and total limits', () => {
    const items = Array.from({ length: 90 }, (_, index) => ({
        ...diagnostic(
            index % 2 === 0 ? 1 : 2,
            `/workspace/src/${index % 3}.ts`
        ),
        message: `Issue ${index}`,
    }))
    const output = formatDiagnostics(items, '/workspace', 'all')

    assert.match(output.text, /WARN/)
    assert.match(output.text, /10 more in this file/)
    assert.match(output.text, /40 more diagnostics total/)
    assert.deepEqual(
        {
            total: output.total,
            returned: output.returned,
            omitted: output.omitted,
        },
        { total: 90, returned: 50, omitted: 40 }
    )
})

test('bounds diagnostic messages and total output by UTF-8 bytes', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
        ...diagnostic(1, `/workspace/src/${index}.ts`),
        message: '漢'.repeat(10_000),
    }))
    const output = formatDiagnostics(items, '/workspace', 'all')

    assert.ok(Buffer.byteLength(output.text) <= 12 * 1024)
    assert.ok(output.text.split('\n').length <= 200)
    assert.equal(output.total, 50)
    assert.equal(output.returned + output.omitted, output.total)
    assert.equal(output.truncated, true)
})

test('keeps embedded diagnostic newlines within the physical line limit', () => {
    const output = formatDiagnostics(
        [
            {
                ...diagnostic(1, '/workspace/src/app.ts'),
                message: Array.from({ length: 300 }, () => 'line').join('\n'),
            },
        ],
        '/workspace',
        'all'
    )

    assert.ok(output.text.split('\n').length <= 200)
    assert.match(output.text, /line\\nline/)
})

test('does not split multibyte diagnostic messages', () => {
    const output = formatDiagnostic({
        ...diagnostic(1, '/workspace/src/app.ts'),
        message: '漢'.repeat(1_000),
    })

    assert.ok(Buffer.byteLength(output) <= 600)
    assert.doesNotMatch(output, /�/)
    assert.match(output, /\[truncated\]/)
})
