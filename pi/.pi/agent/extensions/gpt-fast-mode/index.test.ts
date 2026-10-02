import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { isCodexRequest } from './request.ts'

const { default: gptFastMode } = await createJiti(import.meta.url).import<
    typeof import('./index.ts')
>('./index.ts')

test('only Codex requests for a registered Codex Responses model qualify', () => {
    const model = { provider: 'openai-codex', id: 'gpt-6-luna' }
    const registered = { api: 'openai-codex-responses' }
    assert.equal(isCodexRequest(model, registered, { model: model.id }), true)
    assert.equal(isCodexRequest(model, undefined, { model: model.id }), false)
    assert.equal(
        isCodexRequest(model, { api: 'openai-responses' }, { model: model.id }),
        false
    )
    assert.equal(
        isCodexRequest({ ...model, provider: 'openai' }, registered, {
            model: model.id,
        }),
        false
    )
    assert.equal(isCodexRequest(model, registered, { model: 'other' }), false)
    assert.equal(isCodexRequest(model, registered, null), false)
})

test('toggle and session defaults patch only matching requests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-fast-mode-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = directory
    try {
        writeFileSync(
            join(directory, 'settings.json'),
            JSON.stringify({ 'pi-gpt-fast-mode': { enabled: true } })
        )
        writeFileSync(
            join(directory, 'keybindings.json'),
            JSON.stringify({ 'pi-gpt-fast-mode': ['ctrl+alt+m', 'ctrl+m'] })
        )
        const events = new Map<string, (...args: any[]) => unknown>()
        const commands = new Map<string, (...args: any[]) => unknown>()
        const shortcuts: string[] = []
        const pi = {
            on: (name: string, handler: (...args: any[]) => unknown) =>
                events.set(name, handler),
            registerCommand: (
                name: string,
                options: { handler: (...args: any[]) => unknown }
            ) => commands.set(name, options.handler),
            registerShortcut: (key: string) => shortcuts.push(key),
        } as unknown as ExtensionAPI
        gptFastMode(pi)
        assert.deepEqual(shortcuts, ['ctrl+alt+m'])

        const ctx = {
            model: { provider: 'openai-codex', id: 'gpt-6-luna' },
            modelRegistry: {
                find: (_provider: string, id: string) =>
                    id === 'gpt-6-luna'
                        ? { api: 'openai-codex-responses' }
                        : undefined,
            },
            hasUI: false,
        } as unknown as ExtensionContext
        const request = events.get('before_provider_request')!
        const payload = { model: 'gpt-6-luna', input: ['hello'] }
        assert.deepEqual(request({ payload }, ctx), {
            ...payload,
            service_tier: 'priority',
        })
        assert.deepEqual(payload, { model: 'gpt-6-luna', input: ['hello'] })
        assert.equal(request({ payload: { model: 'other' } }, ctx), undefined)
        commands.get('fast')!('', ctx)
        assert.equal(request({ payload }, ctx), undefined)
        events.get('session_start')!()
        assert.deepEqual(request({ payload }, ctx), {
            ...payload,
            service_tier: 'priority',
        })
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = previous
        rmSync(directory, { recursive: true, force: true })
    }
})
