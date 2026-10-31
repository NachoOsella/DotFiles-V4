import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Check } from 'typebox/value'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import {
    buildChildToolDefinitions,
    buildRootToolDefinitions,
} from './extension-tools.ts'

interface StructuredTool {
    readonly name: string
    readonly outputSchema: unknown
    readonly execute: (
        toolCallId: string,
        params: unknown,
        signal: undefined,
        onUpdate: undefined,
        ctx: undefined
    ) => Promise<{
        readonly content: ReadonlyArray<{ readonly text?: string }>
        readonly details: unknown
        readonly structuredContent?: unknown
    }>
}

const records: Record<string, unknown> = {
    '/root/child': {
        role: 'reviewer',
        model: 'provider/model',
        thinkingLevel: 'high',
    },
    '/root/worker': { thinkingLevel: 'medium' },
}

const manager = {
    getConfig: () => DEFAULT_SUBAGENTS_CONFIG,
    spawn: async (input: { taskName: string }) => ({
        path: `/root/${input.taskName}`,
        id: 'agent-id',
    }),
    getRecordByPath: (path: string) => records[path as string],
    sendMessage: async () => undefined,
    followup: async () => undefined,
    wait: async () => ({ message: 'Wait completed.', timedOut: false }),
    interrupt: async () => ({ _tag: 'Interrupted' }),
    list: () => [
        {
            path: '/root/worker',
            status: 'Running',
            residency: 'loaded',
            role: 'reviewer',
            model: 'provider/model',
            parentPath: '/root',
            hasPendingMail: false,
            running: true,
            waiting: true,
        },
    ],
}

const tools = buildRootToolDefinitions(
    manager as never
) as unknown as StructuredTool[]

function tool(name: string): StructuredTool {
    const found = tools.find((entry) => entry.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
}

const cases: ReadonlyArray<{ name: string; params: unknown }> = [
    {
        name: 'spawn_agent',
        params: {
            message: 'Review the diff.',
            task_name: 'child',
            fork_turns: 'none',
        },
    },
    {
        name: 'send_message',
        params: { target: '/root/child', message: 'note' },
    },
    {
        name: 'followup_task',
        params: { target: '/root/child', message: 'more work' },
    },
    { name: 'wait_agent', params: { timeout_ms: 10_000 } },
    { name: 'interrupt_agent', params: { target: '/root/child' } },
    { name: 'list_agents', params: { path_prefix: '/root' } },
]

describe('structured tool results match declared schemas', () => {
    for (const entry of cases) {
        it(`${entry.name} returns details that validate`, async () => {
            const definition = tool(entry.name)
            const result = await definition.execute(
                'call-1',
                entry.params,
                undefined,
                undefined,
                undefined
            )
            assert.equal(result.structuredContent, result.details)
            assert.deepEqual(
                JSON.parse(String(result.content[0]?.text)),
                result.details
            )
            assert.ok(
                Check(
                    definition.outputSchema as never,
                    result.details as never
                ),
                `${entry.name} details do not match its outputSchema`
            )
        })
    }

    it('maps additive mail, activity and wake-reason fields only when present', async () => {
        const listTool = tool('list_agents')
        const listResult = await listTool.execute(
            'call-1',
            {},
            undefined,
            undefined,
            undefined
        )
        const listed = listResult.details as {
            agents: Array<Record<string, unknown>>
        }
        assert.equal(listed.agents[0]?.has_pending_mail, false)
        assert.equal('has_pending_activity' in (listed.agents[0] ?? {}), false)

        const waitTool = tool('wait_agent')
        const waitResult = await waitTool.execute(
            'call-2',
            { timeout_ms: 10_000 },
            undefined,
            undefined,
            undefined
        )
        assert.equal('wake_reason' in (waitResult.details as object), false)
    })

    it('reports why a saved agent is blocked without changing its status field', async () => {
        const blocked = buildRootToolDefinitions({
            ...manager,
            list: () => [
                {
                    path: '/root/stale',
                    status: 'Completed',
                    residency: 'unloaded',
                    model: 'provider/model',
                    parentPath: '/root',
                    hasPendingMail: false,
                    hasPendingActivity: false,
                    blockedReason: 'role "reviewer" is no longer configured',
                    running: false,
                    waiting: false,
                },
            ],
        } as never).find(
            (entry) => (entry as { name: string }).name === 'list_agents'
        ) as unknown as StructuredTool
        const result = await blocked.execute(
            'call-1',
            {},
            undefined,
            undefined,
            undefined
        )
        const agent = (
            result.details as {
                agents: Array<{ agent_status: string; blocked_reason?: string }>
            }
        ).agents[0]
        assert.equal(agent?.agent_status, 'Completed')
        assert.match(agent?.blocked_reason ?? '', /no longer configured/)
        assert.ok(Check(blocked.outputSchema as never, result.details as never))
    })

    it('keeps the declared collaboration family and direct exposure', () => {
        assert.deepEqual(
            tools.map((entry) => entry.name),
            [
                'spawn_agent',
                'send_message',
                'followup_task',
                'wait_agent',
                'interrupt_agent',
                'list_agents',
            ]
        )
    })

    it('resolves the manager per call for root tools', async () => {
        let active = manager
        const lazy = buildRootToolDefinitions(() => active as never).find(
            (entry) => (entry as { name: string }).name === 'list_agents'
        ) as unknown as StructuredTool
        const first = await lazy.execute(
            'call-1',
            {},
            undefined,
            undefined,
            undefined
        )
        assert.equal((first.details as { agents: unknown[] }).agents.length, 1)
        active = { ...manager, list: () => [] }
        const second = await lazy.execute(
            'call-2',
            {},
            undefined,
            undefined,
            undefined
        )
        assert.deepEqual(second.details, { agents: [] })
    })

    it('fails closed for an unknown root session identity', async () => {
        const strict = {
            ...manager,
            callerFromSession: (sessionId: string) => {
                throw new Error(`Agent not found: "session:${sessionId}".`)
            },
        }
        const list = buildRootToolDefinitions(strict as never).find(
            (entry) => (entry as { name: string }).name === 'list_agents'
        ) as unknown as StructuredTool
        await assert.rejects(
            list.execute('call-1', {}, undefined, undefined, {
                sessionManager: { getSessionId: () => 'ghost-session' },
                cwd: '/repo',
            } as never),
            /Agent not found/
        )
    })

    it('keeps a pinned child caller without session lookup', async () => {
        const child = buildChildToolDefinitions(
            manager as never,
            '/root/worker' as never
        ).find(
            (entry) => (entry as { name: string }).name === 'list_agents'
        ) as unknown as StructuredTool
        const result = await child.execute('call-1', {}, undefined, undefined, {
            sessionManager: { getSessionId: () => 'ghost-session' },
            cwd: '/repo',
        } as never)
        assert.ok(
            Check(
                (child as { outputSchema?: unknown }).outputSchema as never,
                result.details as never
            )
        )
    })
})
