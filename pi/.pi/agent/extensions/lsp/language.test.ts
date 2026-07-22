import test from 'node:test'
import assert from 'node:assert/strict'
import { languageIdForPath } from './src/language.ts'

test('maps common source extensions to LSP language ids', () => {
    assert.equal(languageIdForPath('src/app.ts'), 'typescript')
    assert.equal(languageIdForPath('src/App.java'), 'java')
    assert.equal(languageIdForPath('Dockerfile'), 'dockerfile')
    assert.equal(languageIdForPath('README.unknown'), 'plaintext')
})
