import test from 'node:test'
import assert from 'node:assert/strict'
import { compactLspResult } from './src/format.ts'

test('compacts navigation results instead of serializing raw LSP payloads', async () => {
    const result = await compactLspResult(
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

test('caps large symbol results', async () => {
    const result = await compactLspResult(
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
    assert.match(result.summary, /More results available: offset=20/)
    assert.equal(result.nextOffset, 20)
})

test('keeps large hover output within the token budget', async () => {
    const result = await compactLspResult(
        'hover',
        { contents: { kind: 'markdown', value: 'x'.repeat(10_000) } },
        '/workspace'
    )

    assert.ok(result.summary.length <= 3_000)
    assert.equal(result.truncated, true)
    assert.match(result.summary, /\[truncated\]/)
})

test('supports LocationLink results and pagination', async () => {
    const result = await compactLspResult(
        'definition',
        [
            {
                targetUri: 'file:///workspace/src/linked.ts',
                targetSelectionRange: {
                    start: { line: 8, character: 3 },
                    end: { line: 8, character: 7 },
                },
            },
        ],
        '/workspace',
        { limit: 1, offset: 0 }
    )

    assert.equal(result.resultCount, 1)
    assert.match(result.summary, /src\/linked\.ts \(9:4\)/)
    assert.equal(result.nextOffset, undefined)
})
