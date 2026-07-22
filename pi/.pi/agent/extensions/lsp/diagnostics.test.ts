import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDiagnostics } from './src/diagnostics.ts'
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

    assert.match(output, /<diagnostics file="src\/app\.ts">/)
    assert.match(output, /ERROR \[2:3\] Type error/)
    assert.doesNotMatch(output, /WARN/)
})
