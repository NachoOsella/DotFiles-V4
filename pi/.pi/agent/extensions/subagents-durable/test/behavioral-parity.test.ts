/**
 * Behavioral parity through the real Harness.
 *
 * Every case drives a scripted faux model to call the native tools, so the
 * assertions observe durable commits and resolved agent state, never a direct
 * `execute()` call. These tests intentionally encode the corrected contract:
 * they must fail against the known spawn bugs (bare task_name, role model
 * winning an explicit override, role tools intersecting inherited tools).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@earendil-works/chord'
import {
    Type,
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from '@earendil-works/pi-ai'
import type {
    FauxProviderHandle,
    FauxResponseFactory,
    MutableModels,
} from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type {
    ContextView,
    Conversation,
    ConversationId,
    Extension,
} from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG, type SubagentsConfig } from '../src/config/config.js'
import { createSubagentsExtension } from '../src/extension.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'
import {
    createAgentConversation,
    createTestHarness,
} from '../src/testing/index.js'
import type { TestHarness } from '../src/testing/index.js'

type ScriptedCall = {
    readonly name: string
    readonly arguments: Parameters<typeof fauxToolCall>[1]
}

const alphaTool = defineTool({
    name: 'alpha',
    description: 'alpha capability',
    parameters: Type.Object({}),
    execute: async () => ({
        content: [{ type: 'text' as const, text: 'alpha' }],
    }),
})

const extraTools: Extension = defineExtension({
    name: 'extra-tools',
    tools: [alphaTool],
})

function hasEnvelope(context: {
    messages: readonly { role: string; content: unknown }[]
}): boolean {
    return context.messages.some((message) => {
        if (message.role !== 'user') return false
        const text =
            typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content)
        return text.includes('Message Type:')
    })
}

function hasToolResult(context: {
    messages: readonly { role: string }[]
}): boolean {
    return context.messages.some((message) => message.role === 'toolResult')
}

/** First request runs the scripted calls; later requests answer plainly. */
function routeCalls(calls: readonly ScriptedCall[]): FauxResponseFactory {
    return (context) => {
        if (hasEnvelope(context) || hasToolResult(context)) {
            return fauxAssistantMessage('agent done')
        }
        return fauxAssistantMessage(
            calls.map((call) => fauxToolCall(call.name, call.arguments)),
            { stopReason: 'toolUse' }
        )
    }
}

async function setup(
    options: {
        config?: Partial<SubagentsConfig>
        extensions?: readonly Extension[]
        models?: MutableModels
        faux?: FauxProviderHandle
    } = {}
): Promise<TestHarness> {
    const config = { ...DEFAULT_CONFIG, ...options.config }
    const faux = options.faux ?? fauxProvider()
    const models = options.models ?? createModels()
    const harness = await createTestHarness({ faux, models, tasks: [] })
    harness.registry.install(
        createSubagentsExtension({ config, submitWrite: harness.submitWrite })
    )
    for (const extension of options.extensions ?? []) {
        harness.registry.install(extension)
    }
    return harness
}

async function configureRoot(
    harness: TestHarness,
    modelId: string = harness.modelId
): Promise<Conversation> {
    const root = await harness.harness.root(harness.context)
    await root.configure(
        { model: { provider: harness.provider, modelId } },
        harness.context
    )
    return root
}

async function runCalls(
    harness: TestHarness,
    conversation: Conversation,
    calls: readonly ScriptedCall[],
    input = 'go'
): Promise<void> {
    harness.faux!.setResponses(
        Array.from({ length: 80 }, () => routeCalls(calls))
    )
    const submission = await conversation.submit(
        { type: 'input', content: input },
        harness.context
    )
    const settled = await submission.wait(harness.context)
    assert.equal(settled.status, 'done')
}

function toolResults(
    view: ContextView,
    toolName: string
): { isError: boolean; text: string }[] {
    const results: { isError: boolean; text: string }[] = []
    for (const entry of view.entries) {
        for (const message of entry.model ?? []) {
            if (
                message.role !== 'toolResult' ||
                message.toolName !== toolName
            ) {
                continue
            }
            const text = message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n')
            results.push({ isError: message.isError, text })
        }
    }
    return results
}

function spawnDetails(view: ContextView): Record<string, unknown>[] {
    return toolResults(view, 'spawn_agent').map(
        (result) => JSON.parse(result.text) as Record<string, unknown>
    )
}

async function childConversation(
    harness: TestHarness,
    path: string
): Promise<Conversation> {
    const state = await harness.harness.snapshot(SubagentsDoc, harness.context)
    const metadata = state?.agents[path]
    assert.ok(metadata, `agent ${path} is registered`)
    const conversation = await harness.harness.conversation(
        metadata.conversationId,
        harness.context
    )
    assert.ok(conversation, `conversation for ${path} exists`)
    return conversation
}

test('spawn_agent returns the canonical path for a root caller', async () => {
    const harness = await setup()
    try {
        const root = await configureRoot(harness)
        await runCalls(harness, root, [
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'worker',
                    message: 'do work',
                    fork_turns: 'none',
                },
            },
        ])
        const view = await root.context(harness.context)
        const [details] = spawnDetails(view)
        assert.equal(details?.task_name, '/root/worker')
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('spawn_agent returns the canonical path for a nested caller', async () => {
    const harness = await setup()
    try {
        const root = await configureRoot(harness)
        const worker = await createAgentConversation(harness, {
            path: '/root/worker',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        const workerConversation = await childConversation(
            harness,
            '/root/worker'
        )
        await runCalls(harness, workerConversation, [
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'nested',
                    message: 'do nested work',
                    fork_turns: 'none',
                },
            },
        ])
        const view = await workerConversation.context(harness.context)
        const [details] = spawnDetails(view)
        assert.equal(details?.task_name, '/root/worker/nested')
        assert.equal(worker.path, '/root/worker')
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('role defaults apply to a fresh fork and explicit overrides win', async () => {
    const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-b' }] })
    const harness = await setup({
        faux,
        models: createModels(),
        config: {
            roles: {
                reviewer: { model: 'faux/faux-b', thinkingLevel: 'low' },
            },
        },
    })
    try {
        const root = await configureRoot(harness, 'faux-1')
        await runCalls(harness, root, [
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'role_default',
                    message: 'role defaults',
                    agent_type: 'reviewer',
                    fork_turns: 'none',
                },
            },
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'explicit_wins',
                    message: 'explicit overrides',
                    agent_type: 'reviewer',
                    model: 'faux/faux-1',
                    reasoning_effort: 'high',
                    fork_turns: 'none',
                },
            },
        ])
        const view = await root.context(harness.context)
        const details = spawnDetails(view)
        assert.equal(details[0]?.model, 'faux/faux-b')
        assert.equal(details[0]?.thinking_level, 'low')
        assert.equal(details[1]?.model, 'faux/faux-1')
        assert.equal(details[1]?.thinking_level, 'high')

        const roleDefault = await childConversation(
            harness,
            '/root/role_default'
        )
        const roleAgent = await roleDefault.agent(harness.context)
        assert.equal(roleAgent.model?.modelId, 'faux-b')
        assert.equal(roleAgent.thinkingLevel, 'low')

        const explicit = await childConversation(harness, '/root/explicit_wins')
        const explicitAgent = await explicit.agent(harness.context)
        assert.equal(explicitAgent.model?.modelId, 'faux-1')
        assert.equal(explicitAgent.thinkingLevel, 'high')
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('role tools add to inherited tools and retain collaboration tools', async () => {
    const harness = await setup({
        extensions: [extraTools],
        config: {
            roles: { tool_role: { tools: ['alpha'] } },
        },
    })
    try {
        const root = await configureRoot(harness)
        const rootAgent = await root.agent(harness.context)
        await root.configure(
            {
                tools: rootAgent.tools.filter((tool) => tool.name !== 'alpha'),
            },
            harness.context
        )
        await runCalls(harness, root, [
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'tooled',
                    message: 'role tools',
                    agent_type: 'tool_role',
                    fork_turns: 'none',
                },
            },
        ])
        const child = await childConversation(harness, '/root/tooled')
        const agent = await child.agent(harness.context)
        const names = agent.tools.map((tool) => tool.name)
        assert.ok(names.includes('alpha'), `alpha is added: ${names.join(',')}`)
        assert.ok(
            names.includes('send_message'),
            `collaboration tools are retained: ${names.join(',')}`
        )
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('role tools union keeps collaboration tools at the depth limit', async () => {
    const harness = await setup({
        extensions: [extraTools],
        config: {
            maxDepth: 0,
            roles: { tool_role: { tools: ['alpha'] } },
        },
    })
    try {
        const root = await configureRoot(harness)
        await runCalls(harness, root, [
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'shallow',
                    message: 'at the depth limit',
                    agent_type: 'tool_role',
                    fork_turns: 'none',
                },
            },
        ])
        const child = await childConversation(harness, '/root/shallow')
        const agent = await child.agent(harness.context)
        const names = agent.tools.map((tool) => tool.name)
        assert.ok(
            !names.includes('spawn_agent'),
            `spawn is removed: ${names.join(',')}`
        )
        assert.ok(
            names.includes('send_message'),
            `collaboration remains: ${names.join(',')}`
        )
        assert.ok(
            names.includes('alpha'),
            `role addition remains: ${names.join(',')}`
        )
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('full-fork model overrides are rejected by the spawn tool', async () => {
    const harness = await setup()
    try {
        const root = await configureRoot(harness)
        await runCalls(harness, root, [
            {
                name: 'spawn_agent',
                arguments: {
                    task_name: 'full_fork',
                    message: 'inherit everything',
                    model: 'faux/other',
                    fork_turns: 'all',
                },
            },
        ])
        const view = await root.context(harness.context)
        const [result] = toolResults(view, 'spawn_agent')
        assert.equal(result?.isError, true)
        assert.match(result?.text ?? '', /not allowed with fork_turns=all/)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('followup_task cannot target the root agent', async () => {
    const harness = await setup()
    try {
        const root = await configureRoot(harness)
        await runCalls(harness, root, [
            {
                name: 'followup_task',
                arguments: { target: '/root', message: 'wake root' },
            },
        ])
        const view = await root.context(harness.context)
        const [result] = toolResults(view, 'followup_task')
        assert.equal(result?.isError, true)
        assert.match(result?.text ?? '', /cannot target the root agent/)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('interrupt_agent rejects the root and the caller itself', async () => {
    const harness = await setup()
    try {
        const root = await configureRoot(harness)
        await runCalls(harness, root, [
            {
                name: 'interrupt_agent',
                arguments: { target: '/root' },
            },
        ])
        const rootView = await root.context(harness.context)
        const [rootResult] = toolResults(rootView, 'interrupt_agent')
        assert.equal(rootResult?.isError, true)
        assert.match(
            rootResult?.text ?? '',
            /cannot target the root agent or itself/
        )

        const worker = await createAgentConversation(harness, {
            path: '/root/worker',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        const workerConversation = await childConversation(harness, worker.path)
        await runCalls(harness, workerConversation, [
            {
                name: 'interrupt_agent',
                arguments: { target: '/root/worker' },
            },
        ])
        const workerView = await workerConversation.context(harness.context)
        const [selfResult] = toolResults(workerView, 'interrupt_agent')
        assert.equal(selfResult?.isError, true)
        assert.match(
            selfResult?.text ?? '',
            /cannot target the root agent or itself/
        )
    } finally {
        await harness.harness.close(harness.context)
    }
})
