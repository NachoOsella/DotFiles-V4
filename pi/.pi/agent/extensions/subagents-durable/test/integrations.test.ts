/**
 * Optional host integrations: native coding tools and native tool search.
 *
 * Both run through the real Harness with the faux provider. No AgentSession.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
    Type,
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from '@earendil-works/pi-ai'
import type { ConversationId, EnvTarget } from '@earendil-works/pi-durable'
import {
    Harness,
    createRegistry,
    defineExtension,
    defineTool,
} from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import {
    createCodingToolsExtension,
    createNodeEnvironment,
} from '../src/integrations/coding-tools.js'
import { createToolSearchExtension } from '../src/integrations/tool-search.js'
import {
    openSubagentsHarness,
    defaultSubagentsStoragePath,
    type SubagentsHarnessHandle,
} from '../src/host.js'
import { createProjectionSource } from '../src/ui/source.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'

const user = (text: string) => ({
    role: 'user' as const,
    content: text,
    timestamp: 0,
})

test('coding tools expose read, write, edit, and bash', () => {
    const extension = createCodingToolsExtension()
    assert.equal(extension.name, 'coding-tools')
    assert.deepEqual(extension.tools?.map((tool) => tool.name).sort(), [
        'bash',
        'edit',
        'read',
        'write',
    ])
})

test('the Node environment reads and writes relative to the conversation cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subagents-durable-'))
    try {
        const env = await createNodeEnvironment({ cwd: dir })(
            { cwd: dir } as unknown as EnvTarget,
            BACKGROUND_CONTEXT
        )
        assert.ok(env)
        assert.equal(env.cwd, dir)
        const written = await env.writeFile(
            'note.txt',
            'hello',
            BACKGROUND_CONTEXT
        )
        assert.equal(written.ok, true)
        const read = await env.readTextFile('note.txt', BACKGROUND_CONTEXT)
        assert.equal(read.ok && read.value, 'hello')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('tool search adds a matching tool from a selected extension', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const alpha = defineTool({
        name: 'alpha',
        description: 'alpha capability',
        parameters: Type.Object({}),
        execute: async () => ({
            content: [{ type: 'text' as const, text: 'alpha' }],
        }),
    })
    const registry = createRegistry()
    const toolSearch = createToolSearchExtension()
    registry.install(toolSearch)
    registry.install(defineExtension({ name: 'extra', tools: [alpha] }))
    const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry },
        BACKGROUND_CONTEXT
    )
    try {
        const root = await harness.root(BACKGROUND_CONTEXT)
        await root.configure(
            {
                model: {
                    provider: faux.getModel().provider,
                    modelId: faux.getModel().id,
                },
                tools: toolSearch.tools ?? [],
            },
            BACKGROUND_CONTEXT
        )
        harness.resume()
        faux.setResponses([
            fauxAssistantMessage(
                [fauxToolCall('tool_search', { query: 'alpha' })],
                { stopReason: 'toolUse' }
            ),
            fauxAssistantMessage('done'),
        ])
        const submission = await root.submit(
            { type: 'input', content: 'find alpha' },
            BACKGROUND_CONTEXT
        )
        const settled = await submission.wait(BACKGROUND_CONTEXT)
        assert.equal(settled.status, 'done')
        const agent = await root.agent(BACKGROUND_CONTEXT)
        assert.ok(
            agent.tools.some((tool) => tool.name === 'alpha'),
            'alpha was added to the offered tools'
        )
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})

test('tool search ignores tools from extensions the conversation did not select', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const alpha = defineTool({
        name: 'alpha',
        description: 'alpha capability',
        parameters: Type.Object({}),
        execute: async () => ({
            content: [{ type: 'text' as const, text: 'alpha' }],
        }),
    })
    const toolSearch = createToolSearchExtension()
    const registry = createRegistry()
    registry.install(toolSearch)
    registry.install(defineExtension({ name: 'extra', tools: [alpha] }))
    const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry },
        BACKGROUND_CONTEXT
    )
    try {
        const root = await harness.root(BACKGROUND_CONTEXT)
        await root.configure(
            {
                model: {
                    provider: faux.getModel().provider,
                    modelId: faux.getModel().id,
                },
                extensions: [toolSearch],
                tools: toolSearch.tools ?? [],
            },
            BACKGROUND_CONTEXT
        )
        harness.resume()
        faux.setResponses([
            fauxAssistantMessage(
                [fauxToolCall('tool_search', { query: 'alpha' })],
                { stopReason: 'toolUse' }
            ),
            fauxAssistantMessage('done'),
        ])
        const submission = await root.submit(
            { type: 'input', content: 'find alpha' },
            BACKGROUND_CONTEXT
        )
        const settled = await submission.wait(BACKGROUND_CONTEXT)
        assert.equal(settled.status, 'done')
        const agent = await root.agent(BACKGROUND_CONTEXT)
        assert.deepEqual(
            agent.tools.map((tool) => tool.name),
            ['tool_search']
        )
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})

test('the tool search extension is named and registered once', () => {
    const extension = createToolSearchExtension()
    assert.equal(extension.name, 'tool-search')
    assert.deepEqual(
        extension.tools?.map((tool) => tool.name),
        ['tool_search']
    )
})

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000
): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs)
            throw new Error('timed out waiting for projection')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

async function registerAgent(
    handle: SubagentsHarnessHandle,
    path: string,
    parentPath: string
): Promise<ConversationId> {
    return handle.harness.commit(async (tx) => {
        const state = await tx.doc(SubagentsDoc)
        const conversation = await tx.createConversation({
            ownership: { kind: 'ownerless' },
        })
        state.agents[path] = {
            name: path.split('/').at(-1) ?? path,
            path,
            parentPath,
            conversationId: conversation.id,
            createdAt: Date.now(),
        }
        return conversation.id
    }, BACKGROUND_CONTEXT)
}

test('the host requires a reopenable location', async () => {
    await assert.rejects(
        openSubagentsHarness({ models: createModels() }, BACKGROUND_CONTEXT),
        /hostId/
    )
})

test('the projection source sees a spawn that happens after attach', async () => {
    const handle = await openSubagentsHarness(
        { models: createModels(), storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        const source = await handle.watchProjection(BACKGROUND_CONTEXT)
        try {
            await waitFor(() => source.read().agents.length === 0)
            await registerAgent(handle, '/root/after', '/root')
            await waitFor(() =>
                source
                    .read()
                    .agents.some((agent) => agent.path === '/root/after')
            )
        } finally {
            source.dispose()
        }
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('the projection source hydrates a restored registry on attach', async () => {
    const handle = await openSubagentsHarness(
        { models: createModels(), storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        await registerAgent(handle, '/root/existing', '/root')
        const source = await handle.watchProjection(BACKGROUND_CONTEXT)
        try {
            await waitFor(() =>
                source
                    .read()
                    .agents.some((agent) => agent.path === '/root/existing')
            )
        } finally {
            source.dispose()
        }
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('the projection source keeps the newest state during rapid changes', async () => {
    const handle = await openSubagentsHarness(
        { models: createModels(), storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        const source = await handle.watchProjection(BACKGROUND_CONTEXT)
        try {
            await Promise.all([
                registerAgent(handle, '/root/a', '/root'),
                registerAgent(handle, '/root/b', '/root'),
                registerAgent(handle, '/root/c', '/root'),
            ])
            await waitFor(() => source.read().agents.length === 3)
        } finally {
            source.dispose()
        }
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('a disposed projection source stops updating', async () => {
    const handle = await openSubagentsHarness(
        { models: createModels(), storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        const source = await handle.watchProjection(BACKGROUND_CONTEXT)
        let notifications = 0
        source.subscribe(() => {
            notifications += 1
        })
        await waitFor(() => source.read().agents.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 20))
        const before = notifications
        source.dispose()
        await registerAgent(handle, '/root/late', '/root')
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(notifications, before)
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test('a file-backed host reopens the same state and returns its path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subagents-host-'))
    const storagePath = join(dir, 'host.sqlite')
    try {
        const first = await openSubagentsHarness(
            { models: createModels(), storagePath },
            BACKGROUND_CONTEXT
        )
        assert.equal(first.storagePath, storagePath)
        await registerAgent(first, '/root/persisted', '/root')
        await first.close(BACKGROUND_CONTEXT)

        const second = await openSubagentsHarness(
            { models: createModels(), storagePath },
            BACKGROUND_CONTEXT
        )
        try {
            const projection = await second.project(BACKGROUND_CONTEXT)
            assert.ok(
                projection.agents.some(
                    (agent) => agent.path === '/root/persisted'
                )
            )
        } finally {
            await second.close(BACKGROUND_CONTEXT)
        }
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('UI acquisition writes nothing and rejects an uninitialized registry', async () => {
    const harness = await Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT
    )
    try {
        let commits = 0
        const unsubscribe = harness.subscribeCommits(() => {
            commits += 1
        })
        await assert.rejects(
            createProjectionSource(harness, BACKGROUND_CONTEXT, () => {}),
            /registry document is not initialized/
        )
        unsubscribe()
        assert.equal(commits, 0, 'UI acquisition performs no commit')
    } finally {
        await harness.close(BACKGROUND_CONTEXT)
    }
})

test('default storage paths reject unsafe host ids', async () => {
    assert.throws(
        () => defaultSubagentsStoragePath('../escape'),
        /safe filename segment/
    )
    assert.throws(
        () => defaultSubagentsStoragePath('..'),
        /safe filename segment/
    )
    assert.throws(
        () => defaultSubagentsStoragePath(''),
        /safe filename segment/
    )
    assert.throws(
        () => defaultSubagentsStoragePath('a/b'),
        /safe filename segment/
    )
    assert.match(
        defaultSubagentsStoragePath('host-1'),
        /subagents-durable\/host-1\.sqlite$/
    )
    await assert.rejects(
        openSubagentsHarness(
            { models: createModels(), hostId: '../escape' },
            BACKGROUND_CONTEXT
        ),
        /safe filename segment/
    )
})

test('a fresh fork is idle, not completed from an inherited answer', async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const handle = await openSubagentsHarness(
        { models, storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        const parentId = await registerAgent(handle, '/root/parent', '/root')
        const parent = await handle.harness.conversation(
            parentId,
            BACKGROUND_CONTEXT
        )
        assert.ok(parent)
        await parent.configure(
            {
                model: {
                    provider: faux.getModel().provider,
                    modelId: faux.getModel().id,
                },
            },
            BACKGROUND_CONTEXT
        )
        faux.setResponses([fauxAssistantMessage('done')])
        const submission = await parent.submit(
            { type: 'input', content: 'hi' },
            BACKGROUND_CONTEXT
        )
        assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, 'done')

        const tail = (
            await parent.entries({}, 1, undefined, BACKGROUND_CONTEXT)
        ).items[0]?.id
        assert.ok(tail !== undefined)
        await handle.harness.commit(async (tx) => {
            const fork = await tx.forkConversation(parentId, tail, {
                ownership: { kind: 'ownerless' },
            })
            const state = await tx.doc(SubagentsDoc)
            state.agents['/root/fork'] = {
                name: 'fork',
                path: '/root/fork',
                parentPath: '/root',
                conversationId: fork.id,
                createdAt: Date.now(),
            }
        }, BACKGROUND_CONTEXT)

        const projection = await handle.project(BACKGROUND_CONTEXT)
        assert.equal(
            projection.agents.find((agent) => agent.path === '/root/parent')
                ?.status,
            'completed'
        )
        assert.equal(
            projection.agents.find((agent) => agent.path === '/root/fork')
                ?.status,
            'idle'
        )
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})

test("activity shows a tool error's text", async () => {
    const handle = await openSubagentsHarness(
        { models: createModels(), storage: new MemoryStorage() },
        BACKGROUND_CONTEXT
    )
    try {
        const conversationId = await registerAgent(handle, '/root/err', '/root')
        await handle.harness.commit(
            (tx) =>
                tx.appendEntry(conversationId, {
                    kind: 'pi.tool-result',
                    model: [
                        {
                            role: 'toolResult' as const,
                            toolCallId: 'call',
                            toolName: 'bash',
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'boom failure text',
                                },
                            ],
                            isError: true,
                            timestamp: 0,
                        },
                    ],
                }),
            BACKGROUND_CONTEXT
        )
        const source = await handle.watchProjection(BACKGROUND_CONTEXT)
        try {
            const lines = (await source.activity?.(conversationId)) ?? []
            assert.ok(
                lines.some((line) => line.includes('boom failure text')),
                lines.join('\n')
            )
        } finally {
            source.dispose()
        }
    } finally {
        await handle.close(BACKGROUND_CONTEXT)
    }
})
