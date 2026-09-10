import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    filterSubagentsExtension,
    isSubagentsExtensionPath,
} from './src/host-live.ts'

describe('child extension filter', () => {
    it('matches our own entry in posix and windows forms', () => {
        assert.equal(
            isSubagentsExtensionPath(
                '/home/u/.pi/agent/extensions/subagents/index.ts'
            ),
            true
        )
        assert.equal(
            isSubagentsExtensionPath(
                '/home/u/dotfiles/pi/.pi/agent/extensions/subagents/index.ts'
            ),
            true
        )
        assert.equal(
            isSubagentsExtensionPath(
                'C:\\Users\\u\\.pi\\agent\\extensions\\subagents\\index.ts'
            ),
            true
        )
        assert.equal(
            isSubagentsExtensionPath(
                '/home/u/.pi/agent/extensions/todowrite/index.ts'
            ),
            false
        )
        assert.equal(isSubagentsExtensionPath(''), false)
    })

    it('strips only our extension and keeps the rest', () => {
        const extensions = [
            {
                path: 'extensions/subagents/index.ts',
                resolvedPath:
                    '/home/u/dotfiles/pi/.pi/agent/extensions/subagents/index.ts',
            },
            {
                path: 'extensions/todowrite/index.ts',
                resolvedPath:
                    '/home/u/dotfiles/pi/.pi/agent/extensions/todowrite/index.ts',
            },
        ]
        const kept = filterSubagentsExtension(extensions)
        assert.equal(kept.length, 1)
        assert.equal(kept[0]?.path, 'extensions/todowrite/index.ts')
    })
})
