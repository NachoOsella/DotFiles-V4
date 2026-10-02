import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ExecutionLimiter } from './execution-limiter.ts'
import { projectFork } from '../persistence/fork-projector.ts'
import { parseForkTurns } from '../domain/communication.ts'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { WaitHub } from './wait-hub.ts'
import { makeAgentRuntime } from './agent-runtime.ts'
import type { AgentPath } from '../domain/ids.ts'
import {
    findLatestState,
    isPersistedState,
    snapshotAge,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from '../persistence/session-state.ts'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import { COLLABORATION_NAMESPACE } from '../tools/tool-specs.ts'
import { buildRootToolDefinitions } from '../tools/extension-tools.ts'

function assistant(text: string, stopReason: 'stop' | 'toolUse' = 'stop') {
    return {
        role: 'assistant',
        content:
            stopReason === 'stop'
                ? [{ type: 'text', text }]
                : [
                      {
                          type: 'toolCall',
                          id: 'call-1',
                          name: 'bash',
                          arguments: '{}',
                      },
                  ],
        api: 'openai-responses',
        provider: 'test',
        model: 'test-model',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason,
        timestamp: Date.now(),
    }
}

describe('V3 execution limiter', () => {
    it('limits runs and releases each permit exactly once', () => {
        const limiter = new ExecutionLimiter(1)
        const permit = limiter.tryAcquire()
        assert.equal(limiter.active, 1)
        assert.throws(() => limiter.tryAcquire(), /active slots/)
        permit.release()
        permit.release()
        assert.equal(limiter.active, 0)
        const next = limiter.tryAcquire()
        assert.ok(next.sequence > permit.sequence)
    })
})

describe('V3 wait hub', () => {
    it('does not consume content and closes the lost-wakeup window', async () => {
        const hub = new WaitHub()
        hub.notifyMailbox('/root')
        const pending = await hub.wait('/root', 10)
        assert.deepEqual(pending, { kind: 'mailbox', timedOut: false })
        assert.equal(hub.hasPending('/root'), false)

        const future = hub.wait('/root', 100)
        hub.notifySteer('/root')
        assert.deepEqual(await future, { kind: 'steer', timedOut: false })
        assert.equal(hub.hasPending('/root'), false)
    })

    it('does not carry a stale steer into a later wait', async () => {
        const hub = new WaitHub()
        hub.notifySteer('/root')

        const outcome = await hub.wait('/root', 10)
        assert.deepEqual(outcome, { kind: 'mailbox', timedOut: true })
    })

    it('rejects an aborted wait without consuming later mail', async () => {
        const hub = new WaitHub()
        const controller = new AbortController()
        const pending = hub.wait('/root', 60_000, controller.signal)
        controller.abort()
        await assert.rejects(pending, /Wait cancelled/)

        hub.notifyMailbox('/root')
        assert.deepEqual(await hub.wait('/root', 10), {
            kind: 'mailbox',
            timedOut: false,
        })
    })

    it('rejects immediately when the signal is already aborted', async () => {
        const hub = new WaitHub()
        const controller = new AbortController()
        controller.abort()
        await assert.rejects(
            hub.wait('/root', 60_000, controller.signal),
            /Wait cancelled/
        )
    })

    it('reports which paths are blocked in wait', async () => {
        const hub = new WaitHub()
        const pending = hub.wait('/root', 60_000)
        assert.equal(hub.isWaiting('/root'), true)
        assert.equal(hub.isWaiting('/root/other'), false)

        hub.notifyMailbox('/root')
        await pending
        assert.equal(hub.isWaiting('/root'), false)
    })

    it('clear cancels in-flight waits instead of waiting for the timeout', async () => {
        const hub = new WaitHub()
        const pending = hub.wait('/root', 60_000)
        hub.clear()
        await assert.rejects(pending, /Wait cancelled/)
    })
})

describe('agent activity', () => {
    it('carries the error text of a failed tool', () => {
        const activities: Array<{ kind?: string; summary?: string }> = []
        let handler: ((event: unknown) => void) | undefined
        makeAgentRuntime({
            path: '/root/a' as AgentPath,
            session: {
                subscribe: (listener: (event: unknown) => void) => {
                    handler = listener
                    return () => undefined
                },
            } as never,
            onActivity: (activity) => activities.push(activity as never),
        })

        handler?.({
            type: 'tool_execution_end',
            toolCallId: 'call-1',
            toolName: 'read',
            isError: true,
            result: {
                content: [
                    { type: 'text', text: 'ENOENT: no such file\nsecond line' },
                ],
            },
        })
        const failed = activities.find((entry) => entry.kind === 'tool_result')
        assert.equal(
            failed?.summary,
            'read failed: ENOENT: no such file second line'
        )

        handler?.({
            type: 'tool_execution_end',
            toolCallId: 'call-2',
            toolName: 'read',
            isError: false,
            result: { content: [] },
        })
        assert.equal(activities.at(-1)?.summary, 'read completed')
    })
})

describe('collaboration tool contract', () => {
    const manager = {
        getConfig: () => DEFAULT_SUBAGENTS_CONFIG,
        list: () => [
            {
                path: '/root/worker',
                status: 'Running',
                residency: 'loaded',
                model: 'test-model',
                parentPath: '/root',
                hasPendingMail: false,
                running: true,
                waiting: true,
            },
        ],
        getRecordByPath: () => ({ thinkingLevel: 'medium' }),
    } as never

    it('declares an output schema for every collaboration tool', () => {
        const tools = buildRootToolDefinitions(manager) as unknown as Array<{
            name: string
            outputSchema?: unknown
            exposure?: string
            namespace?: { name?: string }
            annotations?: {
                readOnlyHint?: boolean
                destructiveHint?: boolean
            }
        }>
        assert.equal(tools.length, 6)
        for (const tool of tools) {
            assert.ok(tool.outputSchema, `${tool.name} needs an outputSchema`)
            assert.equal(tool.exposure, 'direct')
            assert.equal(tool.namespace?.name, COLLABORATION_NAMESPACE)
            assert.equal(
                typeof tool.annotations?.readOnlyHint,
                'boolean',
                `${tool.name} needs annotation hints`
            )
        }
        const readOnly = tools
            .filter((tool) => tool.annotations?.readOnlyHint)
            .map((tool) => tool.name)
        assert.deepEqual(readOnly, ['wait_agent', 'list_agents'])
        const destructive = tools
            .filter((tool) => tool.annotations?.destructiveHint)
            .map((tool) => tool.name)
        assert.deepEqual(destructive, ['interrupt_agent'])
    })

    it('returns structured content next to the model-facing JSON text', async () => {
        const tools = buildRootToolDefinitions(manager) as unknown as Array<{
            name: string
            execute: (
                id: string,
                params: never,
                signal: undefined,
                onUpdate: undefined,
                ctx: undefined
            ) => Promise<{
                content: Array<{ text?: string }>
                details: unknown
                structuredContent?: unknown
            }>
        }>
        const list = tools.find((tool) => tool.name === 'list_agents')!
        const result = await list.execute(
            'call-1',
            { path_prefix: '/root' } as never,
            undefined,
            undefined,
            undefined
        )

        assert.equal(result.structuredContent, result.details)
        const parsed = JSON.parse(String(result.content[0]?.text)) as {
            agents: Array<{
                agent_name: string
                agent_status: string
                waiting: boolean
            }>
        }
        assert.equal(parsed.agents[0]?.agent_name, '/root/worker')
        assert.equal(parsed.agents[0]?.agent_status, 'Running')
        assert.equal(parsed.agents[0]?.waiting, true)
    })
})

describe('V3 state persistence', () => {
    it('finds the latest snapshot on the branch', () => {
        const session = SessionManager.inMemory('/repo')
        assert.equal(findLatestState(session.getBranch()), undefined)

        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, {
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: 1,
            agents: [],
        })
        session.appendCustomEntry('unrelated', { nope: true })
        session.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, {
            version: 2,
            rootSessionId: 'root-session',
            persistedAt: 2,
            agents: [],
        })

        const found = findLatestState(session.getBranch())
        assert.equal(found?.persistedAt, 2)
        assert.equal(snapshotAge(found!), 2)
    })

    it('ignores unsupported snapshot versions', () => {
        const broken = SessionManager.inMemory('/repo')
        broken.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, { version: 3 })
        assert.equal(findLatestState(broken.getBranch()), undefined)
        assert.equal(isPersistedState({ version: 2 }), false)
    })
})

describe('V3 Pi session persistence characterization', () => {
    it('reopens a nested persistent session with custom communication', async () => {
        const root = await mkdtemp(join(tmpdir(), 'subagents-v3-'))
        const sessions = join(root, '.subagents', 'root-session')
        try {
            const created = SessionManager.create('/repo', sessions)
            created.appendCustomMessageEntry(
                'subagents-v3:communication',
                'Message Type: MESSAGE\\nPayload: kiwi-927',
                false,
                { marker: 'kiwi-927' }
            )
            created.appendMessage(assistant('persisted answer') as never)
            const reopened = SessionManager.open(
                created.getSessionFile()!,
                sessions,
                '/repo'
            )
            const [entry] = reopened.buildContextEntries()
            assert.equal(entry?.type, 'custom_message')
            assert.equal(
                entry?.type === 'custom_message' ? entry.content : undefined,
                'Message Type: MESSAGE\\nPayload: kiwi-927'
            )
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

describe('V3 structured fork projector', () => {
    it('applies the latest branch-relative edits before selecting fork turns', () => {
        const session = SessionManager.inMemory('/repo')
        const removed = session.appendMessage({
            role: 'user',
            content: 'private text',
            timestamp: Date.now(),
        })
        const answer = session.appendMessage(
            assistant('original answer') as never
        )
        session.appendContextEdit(removed, null)
        session.appendContextEdit(answer, { content: 'replacement answer' })
        const editedLeaf = session.getLeafId()!
        for (const policy of ['all', '1']) {
            const fork = projectFork(
                session.getBranch(),
                parseForkTurns(policy)
            )
            assert.deepEqual(
                fork.map((message) =>
                    'content' in message ? message.content : undefined
                ),
                [[{ type: 'text', text: 'replacement answer' }]]
            )
        }
        session.branch(answer)
        assert.match(
            JSON.stringify(
                projectFork(session.getBranch(), parseForkTurns('all'))
            ),
            /private text/
        )
        session.branch(editedLeaf)
        assert.doesNotMatch(
            JSON.stringify(
                projectFork(session.getBranch(), parseForkTurns('all'))
            ),
            /private text/
        )
    })

    it('keeps the compaction summary and applies edits to retained messages', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendMessage({
            role: 'user',
            content: 'old text',
            timestamp: Date.now(),
        })
        const retained = session.appendMessage({
            role: 'user',
            content: 'retained text',
            timestamp: Date.now(),
        })
        session.appendMessage(assistant('retained answer') as never)
        session.appendCompaction('Earlier summary', retained, 100)
        session.appendContextEdit(retained, { content: 'edited retained text' })
        const fork = projectFork(session.getBranch(), parseForkTurns('1'))
        assert.equal(fork[0]?.role, 'compactionSummary')
        assert.match(JSON.stringify(fork), /Earlier summary/)
        assert.match(JSON.stringify(fork), /edited retained text/)
        assert.doesNotMatch(JSON.stringify(fork), /old text/)
    })

    it('keeps structured final turns and drops tool chatter and communication', () => {
        const session = SessionManager.inMemory('/repo')
        session.appendMessage({
            role: 'user',
            content: 'turn one',
            timestamp: Date.now(),
        })
        session.appendMessage(assistant('answer one') as never)
        session.appendMessage(assistant('tool call', 'toolUse') as never)
        session.appendMessage({
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'output' }],
            isError: false,
            timestamp: Date.now(),
        } as never)
        session.appendCustomMessageEntry(
            'subagents-v3:communication',
            'Message Type: FINAL_ANSWER',
            false,
            {}
        )
        session.appendMessage({
            role: 'user',
            content: 'turn two',
            timestamp: Date.now(),
        })
        session.appendMessage(assistant('answer two') as never)

        const all = projectFork(session.getBranch(), parseForkTurns('all'))
        assert.deepEqual(
            all.map((message) => message.role),
            ['user', 'assistant', 'user', 'assistant']
        )
        assert.equal(
            all[1]?.role === 'assistant' ? all[1].content.length : 0,
            1
        )
        assert.equal(
            all[3]?.role === 'assistant' ? all[3].content[0]?.type : undefined,
            'text'
        )

        const last = projectFork(session.getBranch(), parseForkTurns('1'))
        assert.deepEqual(
            last.map((message) =>
                message.role === 'user'
                    ? message.content
                    : message.role === 'assistant'
                      ? message.content[0]?.type
                      : message.role
            ),
            ['turn two', 'text']
        )
    })
})
