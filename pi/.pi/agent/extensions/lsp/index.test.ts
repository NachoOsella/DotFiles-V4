import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import lspExtension, {
    createRuntimeLifecycle,
    normalizeLspArguments,
} from './index.ts'
import type { LspConfig } from './types.ts'

const config: LspConfig = {
    enabled: false,
    diagnosticsAfterEdit: true,
    warmOnRead: false,
    idleTimeoutMs: 180_000,
    servers: {},
}

interface TestTheme {
    fg(color: string, value: string): string
    bold(value: string): string
}

const theme: TestTheme = {
    fg: (_color, value) => value,
    bold: (value) => value,
}

interface RegisteredLspTool {
    renderResult(
        result: {
            content: readonly { type: 'text'; text: string }[]
            details?: unknown
        },
        options: { expanded: boolean; isPartial: boolean },
        theme: TestTheme,
        context: { isError: boolean }
    ): { render(width: number): string[] }
}

function registerExtension() {
    const tools: unknown[] = []
    const handlers = new Map<
        string,
        (event: never, context: never) => unknown
    >()
    const pi = {
        on(name: string, handler: (event: never, context: never) => unknown) {
            handlers.set(name, handler)
        },
        registerTool(tool: unknown) {
            tools.push(tool)
        },
        registerCommand() {},
        events: { emit() {} },
    } as unknown as ExtensionAPI
    lspExtension(pi)
    return { tool: tools[0] as RegisteredLspTool, handlers }
}

test('renderer uses real line breaks and renderer error state', () => {
    const { tool } = registerExtension()
    const result = {
        content: [{ type: 'text' as const, text: 'request failure' }],
        details: {
            operation: 'hover' as const,
            summary: 'first\nsecond\nthird',
            resultCount: 1,
            returnedCount: 1,
            offset: 0,
            truncated: false,
        },
    }

    const rendered = tool
        .renderResult(result, { expanded: true, isPartial: false }, theme, {
            isError: false,
        })
        .render(80)
        .map((line) => line.trimEnd())
        .join('\n')
    assert.match(rendered, /first\nsecond/)
    assert.doesNotMatch(rendered, /first\\nsecond/)

    const error = tool
        .renderResult(result, { expanded: false, isPartial: false }, theme, {
            isError: true,
        })
        .render(80)
        .join('\n')
        .trimEnd()
    assert.equal(error, 'request failure')
})

test('normalizes one leading path marker', () => {
    assert.deepEqual(normalizeLspArguments({ filePath: '@@src/app.ts' }), {
        filePath: '@src/app.ts',
    })
})

test('unrelated successful tool results do not initialize an LSP runtime', async () => {
    const { handlers } = registerExtension()
    const handler = handlers.get('tool_result')
    assert.ok(handler)
    await handler?.(
        {
            toolName: 'bash',
            isError: false,
            input: {},
            details: {},
            content: [],
        } as never,
        {
            cwd: process.cwd(),
            isProjectTrusted: () => false,
        } as never
    )
})

test('runtime lifecycle reuses, replaces, and disposes runtimes', async () => {
    const disposed: number[] = []
    let created = 0
    const lifecycle = createRuntimeLifecycle((_config, _cwd) => {
        const id = created++
        return { dispose: async () => void disposed.push(id) }
    })

    const first = await lifecycle.get('/workspace-a', config)
    const reused = await lifecycle.get('/workspace-a', config)
    const replacement = await lifecycle.get('/workspace-b', config)
    assert.equal(first, reused)
    assert.notEqual(first, replacement)
    assert.deepEqual(disposed, [0])

    await lifecycle.dispose()
    assert.deepEqual(disposed, [0, 1])
})

test('runtime lifecycle recovers after a disposal failure', async () => {
    let created = 0
    let failDisposal = true
    const lifecycle = createRuntimeLifecycle((_config, _cwd) => {
        const id = created++
        return {
            id,
            async dispose() {
                if (failDisposal) {
                    failDisposal = false
                    throw new Error('dispose failed')
                }
            },
        }
    })

    await lifecycle.get('/workspace-a', config)
    await assert.rejects(
        lifecycle.get('/workspace-b', config),
        /dispose failed/
    )
    const recovered = await lifecycle.get('/workspace-b', config)
    assert.equal(recovered.id, 1)
    await lifecycle.dispose()
})
