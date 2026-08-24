import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compactLspResult } from './src/format.ts'

const symbol = (name: string, index: number, uri: string) => ({
    name,
    kind: 12,
    location: {
        uri,
        range: {
            start: { line: index, character: 0 },
            end: { line: index, character: 6 },
        },
    },
})

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

test('uses emitted entries to provide lossless pagination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-pagination-'))
    const filePath = join(root, 'app.ts')
    await writeFile(filePath, 'export {}\n')
    const uri = pathToFileURL(filePath).href
    const results = Array.from({ length: 20 }, (_, index) =>
        symbol(`Symbol${index}-${'x'.repeat(300)}`, index, uri)
    )

    try {
        const first = await compactLspResult(
            'workspaceSymbols',
            results,
            root,
            {
                limit: 20,
            }
        )
        assert.ok(first.returnedCount > 0)
        assert.ok(first.returnedCount < 20)
        assert.equal(first.nextOffset, first.returnedCount)
        assert.ok(first.summary.length <= 3_000)

        const next = await compactLspResult('workspaceSymbols', results, root, {
            limit: 20,
            offset: first.nextOffset,
        })
        assert.match(next.summary, new RegExp(`Symbol${first.returnedCount}-`))
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('counts context snippets against the output budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-snippets-'))
    const filePath = join(root, 'app.ts')
    await writeFile(filePath, `${'x'.repeat(140)}\n`.repeat(30))
    const uri = pathToFileURL(filePath).href
    const results = Array.from({ length: 20 }, (_, index) =>
        symbol(`Symbol${index}`, index + 3, uri)
    )

    try {
        const withoutSnippets = await compactLspResult(
            'workspaceSymbols',
            results,
            root,
            { limit: 20 }
        )
        const withSnippets = await compactLspResult(
            'workspaceSymbols',
            results,
            root,
            { limit: 20, contextLines: 3 }
        )
        assert.ok(withSnippets.returnedCount < withoutSnippets.returnedCount)
        assert.ok(withSnippets.summary.length <= 3_000)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('returns one oversized result without exceeding the summary budget', async () => {
    const result = await compactLspResult(
        'hover',
        { contents: { kind: 'markdown', value: 'x'.repeat(10_000) } },
        '/workspace'
    )

    assert.equal(result.returnedCount, 1)
    assert.equal(result.nextOffset, undefined)
    assert.equal(result.truncated, true)
    assert.ok(result.summary.length <= 3_000)
    assert.match(result.summary, /\[truncated\]/)
})
