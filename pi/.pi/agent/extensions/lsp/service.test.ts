import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rankMatchingServers } from './src/service.ts'

test('prefers TypeScript over Angular for TypeScript source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-priority-'))
    const filePath = join(root, 'component.ts')
    await writeFile(join(root, 'angular.json'), '{}')
    await writeFile(filePath, 'export const component = true\n')

    try {
        const matches = rankMatchingServers(filePath, {
            angular: {
                command: ['ngserver', '--stdio'],
                extensions: ['.ts', '.html'],
                rootMarkers: ['angular.json'],
                requiresRootMarker: true,
                priority: 50,
            },
            typescript: {
                command: ['typescript-language-server', '--stdio'],
                extensions: ['.ts'],
                rootMarkers: ['tsconfig.json', 'package.json'],
                priority: 100,
            },
        })

        assert.deepEqual(matches.map(([id]) => id), ['typescript', 'angular'])
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
