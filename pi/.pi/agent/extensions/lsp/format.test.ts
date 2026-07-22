import test from 'node:test'
import assert from 'node:assert/strict'
import { compactLspResult } from './src/format.ts'

test('compacts navigation results instead of serializing raw LSP payloads', () => {
    const result = compactLspResult(
        'definition',
        [
            {
                uri: 'file:///workspace/src/app.ts',
                range: {
                    start: { line: 4, character: 2 },
                    end: { line: 4, character: 8 },
                },
            },
        ],
        '/workspace'
    )

    assert.equal(result.resultCount, 1)
    assert.match(result.summary, /src\/app\.ts \(5:3\)/)
    assert.doesNotMatch(result.summary, /"uri"/)
})

test('caps large symbol results', () => {
    const result = compactLspResult(
        'workspaceSymbols',
        Array.from({ length: 100 }, (_, index) => ({
            name: `Symbol${index}`,
            kind: 12,
            location: {
                uri: 'file:///workspace/src/app.ts',
                range: {
                    start: { line: index, character: 0 },
                    end: { line: index, character: 6 },
                },
            },
        })),
        '/workspace'
    )

    assert.ok(result.summary.length <= 4_000)
    assert.equal(result.resultCount, 100)
    assert.match(result.summary, /more result\(s\)/)
})
