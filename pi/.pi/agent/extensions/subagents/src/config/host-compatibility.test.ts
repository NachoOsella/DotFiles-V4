import assert from 'node:assert/strict'
import test from 'node:test'
import { VERSION } from '@earendil-works/pi-coding-agent'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import subagentsExtension from '../../index.ts'
import {
    assertSupportedHost,
    isSupportedHostVersion,
} from './host-compatibility.ts'

test('supported Pi releases prepare custom-triggered runs', () => {
    for (const version of ['1.4.0', '1.4.2', '1.5.0', '1.4.0+build.1']) {
        assert.equal(isSupportedHostVersion(version), true)
        assert.doesNotThrow(() => assertSupportedHost(version))
    }
    for (const version of [
        '1.0.0',
        '1.3.99',
        '1.4.0-beta.1',
        '2.0.0',
        'invalid',
    ]) {
        assert.equal(isSupportedHostVersion(version), false)
        assert.throws(
            () => assertSupportedHost(version),
            /requires Pi >=1\.4\.0/
        )
    }
})

test(
    'an unsupported host registers a diagnostic instead of collaboration tools',
    {
        skip: isSupportedHostVersion(VERSION),
    },
    (t) => {
        const handlers = new Map<string, unknown>()
        const diagnostics = t.mock.method(console, 'error', () => {})
        subagentsExtension({
            on: (name: string, handler: unknown) => handlers.set(name, handler),
            registerTool: () =>
                assert.fail('unsupported host registered a tool'),
        } as unknown as ExtensionAPI)
        assert.deepEqual([...handlers.keys()], ['session_start'])
        const start = handlers.get('session_start') as (
            event: unknown,
            ctx: ExtensionContext
        ) => void
        start({ type: 'session_start' }, { hasUI: false } as ExtensionContext)
        assert.equal(diagnostics.mock.callCount(), 1)
        assert.match(
            diagnostics.mock.calls[0]!.arguments[0] as string,
            /Subagents disabled: Subagents requires Pi >=1\.4\.0/
        )
    }
)
