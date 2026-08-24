import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { canonicalWorkspaceFile, rankMatchingServers } from './src/service.ts'

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

        assert.deepEqual(
            matches.map(([id]) => id),
            ['typescript', 'angular']
        )
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test('canonical containment accepts workspace files and rejects escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-lsp-workspace-'))
    const nested = join(root, 'src')
    const internal = join(nested, 'inside.ts')
    const outside = join(tmpdir(), `pi-lsp-outside-${Date.now()}.ts`)
    const externalLink = join(nested, 'external.ts')
    const internalLink = join(nested, 'internal.ts')
    await mkdir(nested)
    await writeFile(internal, 'export {}\n')
    await writeFile(outside, 'export {}\n')

    try {
        await symlink(outside, externalLink)
        await symlink(internal, internalLink)
        assert.equal(canonicalWorkspaceFile(root, 'src/inside.ts'), internal)
        assert.equal(
            canonicalWorkspaceFile(root, `../${basename(outside)}`),
            undefined
        )
        assert.equal(canonicalWorkspaceFile(root, externalLink), undefined)
        assert.equal(canonicalWorkspaceFile(root, internalLink), internal)
    } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { force: true })
    }
})

test('root marker discovery never walks above the workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pi-lsp-root-parent-'))
    const root = join(parent, 'workspace')
    const source = join(root, 'src', 'app.ts')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(parent, 'package.json'), '{}')
    await writeFile(source, 'export {}\n')

    try {
        const matches = rankMatchingServers(
            source,
            {
                typescript: {
                    command: ['typescript-language-server', '--stdio'],
                    extensions: ['.ts'],
                    rootMarkers: ['package.json'],
                    requiresRootMarker: true,
                },
            },
            root
        )
        assert.deepEqual(matches, [])
    } finally {
        await rm(parent, { recursive: true, force: true })
    }
})
