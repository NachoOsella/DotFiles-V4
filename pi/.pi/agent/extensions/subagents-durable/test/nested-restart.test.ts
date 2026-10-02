/**
 * Nested SQLite restart: registry, addressability, and grandchild agent
 * configuration survive reopen.
 *
 * The tree is built by the real collaboration tools (`spawn_agent` called from
 * the root and then from the parent), not by the scenario helper, so the
 * registry, anchor ownership, reporters, and operation receipts are the ones
 * the extension actually writes.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type {
    FauxResponseFactory,
    TranscriptContext,
} from '@earendil-works/pi-ai'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
    createSubagentsExtension,
    type PassiveWriter,
} from '../src/extension.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'
import type { SubagentsState } from '../src/state/subagents-doc.js'
import { createTestHarness } from '../src/testing/index.js'
import type { TestHarness } from '../src/testing/index.js'

function textOf(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .map((part) =>
            part && typeof part === 'object' && 'text' in part
                ? String((part as { text?: unknown }).text ?? '')
                : ''
        )
        .join('')
}

function userText(context: TranscriptContext): string {
    return context.messages
        .filter((message) => message.role === 'user')
        .map((message) => textOf(message.content))
        .join('\n')
}

async function withDatabase(
    run: (database: string, cwd: string) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'subagents-nested-'))
    try {
        await run(join(directory, 'session.sqlite'), join(directory, 'cwd'))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

async function openNativeHarness(database: string): Promise<{
    harness: TestHarness
    attach(harness: Harness): void
}> {
    let current: Harness | undefined
    const submitWrite: PassiveWriter = async (
        conversationId,
        draft,
        context
    ) => {
        const harness = current
        if (harness === undefined) throw new Error('harness not attached')
        const conversation = await harness.conversation(conversationId, context)
        if (conversation === undefined) {
            throw new Error(`Conversation ${conversationId} is missing`)
        }
        return conversation.submit(draft, context)
    }
    const extension = createSubagentsExtension({ submitWrite })
    const harness = await createTestHarness({
        storage: await openNodeSqliteStorage(database),
        extensions: [extension],
    })
    return {
        harness,
        attach: (value) => {
            current = value
        },
    }
}

/** Routes each conversation to its own scripted step by transcript content. */
function spawnChainRouter(harness: TestHarness): FauxResponseFactory {
    const router: FauxResponseFactory = (context) => {
        harness.faux!.appendResponses([router])
        const text = userText(context)
        const hasToolResult = context.messages.some(
            (message) => message.role === 'toolResult'
        )
        if (text.includes('Task name: worker')) {
            return fauxAssistantMessage('worker answer')
        }
        if (text.includes('Task name: parent')) {
            return hasToolResult
                ? fauxAssistantMessage('parent answer')
                : fauxAssistantMessage(
                      [
                          fauxToolCall('spawn_agent', {
                              task_name: 'worker',
                              message: 'worker task',
                              fork_turns: 'none',
                          }),
                      ],
                      { stopReason: 'toolUse' }
                  )
        }
        return hasToolResult
            ? fauxAssistantMessage('root answer')
            : fauxAssistantMessage(
                  [
                      fauxToolCall('spawn_agent', {
                          task_name: 'parent',
                          message: 'parent task',
                          fork_turns: 'none',
                      }),
                  ],
                  { stopReason: 'toolUse' }
              )
    }
    return router
}

async function waitForPaths(
    harness: TestHarness,
    paths: readonly string[]
): Promise<SubagentsState> {
    const watch = await harness.harness.watchDoc(SubagentsDoc, harness.context)
    assert.ok(watch)
    return await new Promise<SubagentsState>((resolve) => {
        const check = (value: SubagentsState | null) => {
            const agents = value?.agents ?? {}
            if (paths.every((path) => agents[path] !== undefined)) {
                watch.stop()
                resolve(value!)
            }
        }
        check(watch.value)
        watch.start(async (value) => {
            check(value)
        })
    })
}

test(
    'nested registry, addressability, and grandchild config survive SQLite reopen',
    { timeout: 20_000 },
    async () => {
        await withDatabase(async (database, cwd) => {
            const opened = await openNativeHarness(database)
            const harness = opened.harness
            opened.attach(harness.harness)
            const firstConversationId: { value?: ConversationId } = {}
            try {
                harness.faux!.setResponses([spawnChainRouter(harness)])
                const root = await harness.harness.root(harness.context)
                await root.configure(
                    {
                        model: {
                            provider: harness.provider,
                            modelId: harness.modelId,
                        },
                    },
                    harness.context
                )
                // The registry document is non-creating on watch; create it so
                // the deterministic path watch has something to attach to.
                await harness.harness.commit(
                    (tx) => tx.doc(SubagentsDoc),
                    harness.context
                )
                await root.submit(
                    { type: 'input', content: 'start' },
                    harness.context
                )

                const state = await waitForPaths(harness, [
                    '/root/parent',
                    '/root/parent/worker',
                ])
                assert.equal(state.agents['/root/parent']?.parentPath, '/root')
                assert.equal(
                    state.agents['/root/parent/worker']?.parentPath,
                    '/root/parent'
                )
                const grandchild = state.agents['/root/parent/worker']
                assert.ok(grandchild !== undefined)
                firstConversationId.value = grandchild.conversationId

                const grandchildConversation =
                    await harness.harness.conversation(
                        grandchild.conversationId,
                        harness.context
                    )
                assert.ok(grandchildConversation)
                const sendMessage = harness.registry
                    .snapshot()
                    .tools()
                    .map((entry) => entry.tool)
                    .find((tool) => tool.name === 'send_message')
                const spawnTool = harness.registry
                    .snapshot()
                    .tools()
                    .map((entry) => entry.tool)
                    .find((tool) => tool.name === 'spawn_agent')
                assert.ok(sendMessage !== undefined)
                assert.ok(spawnTool !== undefined)
                await grandchildConversation!.configure(
                    {
                        model: {
                            provider: harness.provider,
                            modelId: harness.modelId,
                        },
                        thinkingLevel: 'high',
                        cwd,
                        instructions: 'grandchild only instructions',
                        tools: { remove: [spawnTool!, sendMessage!] },
                    },
                    harness.context
                )
                await harness.harness.close(harness.context)
            } finally {
                if (firstConversationId.value === undefined) {
                    await harness.harness
                        .close(harness.context)
                        .catch(() => undefined)
                }
            }

            // First reopen: identities, nesting, config, and addressability.
            const reopened = await openNativeHarness(database)
            try {
                reopened.attach(reopened.harness.harness)
                reopened.harness.faux!.setResponses([
                    spawnChainRouter(reopened.harness),
                ])
                const state = await reopened.harness.harness.snapshot(
                    SubagentsDoc,
                    reopened.harness.context
                )
                const agents = state?.agents ?? {}
                assert.equal(Object.keys(agents).length, 2)
                assert.equal(agents['/root/parent']?.parentPath, '/root')
                const grandchild = agents['/root/parent/worker']
                assert.ok(grandchild !== undefined)
                assert.equal(grandchild.parentPath, '/root/parent')
                assert.equal(grandchild.name, 'worker')
                assert.equal(
                    grandchild.conversationId,
                    firstConversationId.value
                )

                const conversation =
                    await reopened.harness.harness.conversation(
                        grandchild.conversationId,
                        reopened.harness.context
                    )
                assert.ok(conversation)
                const agent = await conversation!.agent(
                    reopened.harness.context
                )
                assert.equal(agent.model?.provider, reopened.harness.provider)
                assert.equal(agent.model?.modelId, reopened.harness.modelId)
                assert.equal(agent.thinkingLevel, 'high')
                assert.equal(agent.cwd, cwd)
                assert.equal(agent.instructions, 'grandchild only instructions')
                const toolNames = agent.tools.map((tool) => tool.name)
                assert.ok(!toolNames.includes('send_message'))
                assert.ok(!toolNames.includes('spawn_agent'))
                assert.ok(toolNames.includes('followup_task'))

                const stored = await reopened.harness.harness.snapshot(
                    AgentDoc,
                    grandchild.conversationId,
                    reopened.harness.context
                )
                assert.equal(stored?.thinkingLevel, 'high')
                assert.equal(stored?.cwd, cwd)
                assert.equal(
                    stored?.instructions,
                    'grandchild only instructions'
                )
            } finally {
                await reopened.harness.harness.close(reopened.harness.context)
            }

            // Second reopen: identity and configuration are stable.
            const again = await openNativeHarness(database)
            try {
                again.attach(again.harness.harness)
                const state = await again.harness.harness.snapshot(
                    SubagentsDoc,
                    again.harness.context
                )
                const grandchild = state?.agents['/root/parent/worker']
                assert.ok(grandchild !== undefined)
                assert.equal(
                    grandchild.conversationId,
                    firstConversationId.value
                )
                assert.equal(grandchild.parentPath, '/root/parent')
                const conversation = await again.harness.harness.conversation(
                    grandchild.conversationId,
                    again.harness.context
                )
                const agent = await conversation!.agent(again.harness.context)
                assert.equal(agent.thinkingLevel, 'high')
                assert.equal(agent.cwd, cwd)
                assert.equal(agent.instructions, 'grandchild only instructions')
            } finally {
                await again.harness.harness.close(again.harness.context)
            }
        })
    }
)
