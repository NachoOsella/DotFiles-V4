/**
 * Read-only UI projection and inspector.
 *
 * The projection is pure over already-read host state. The inspector runs
 * against a fake source so subscription, requestRender, scrolling, and
 * disposal are deterministic.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
    ConversationId,
    LiveState,
    TaskGraph,
    UsageState,
} from '@earendil-works/pi-durable'
import {
    createSubagentInspector,
    type InspectorTheme,
} from '../src/ui/inspector.js'
import {
    agentTree,
    statusFromLive,
    toProjection,
    type AgentSummary,
    type ProjectedAgentInput,
    type SubagentProjection,
    type SubagentProjectionSource,
} from '../src/ui/projection.js'

const theme: InspectorTheme = {
    fg: (_token, text) => text,
    bold: (text) => text,
}
const conversation = (value: number) => value as ConversationId

function input(
    path: string,
    parentPath: string | null,
    id: number,
    extra: Partial<ProjectedAgentInput> = {}
): ProjectedAgentInput {
    return {
        path,
        name: path.split('/').at(-1) ?? path,
        parentPath,
        conversationId: conversation(id),
        createdAt: id,
        ...extra,
    }
}

const emptyGraph: TaskGraph = { tasks: {} }

function projectionWith(
    agents: readonly ProjectedAgentInput[],
    live: ReadonlyMap<ConversationId, LiveState>
): SubagentProjection {
    return toProjection(
        agents,
        emptyGraph,
        live,
        new Map(),
        new Map<ConversationId, UsageState>(),
        0
    )
}

class FakeSource implements SubagentProjectionSource {
    value: SubagentProjection
    activityLines: readonly string[] = []
    disposals = 0
    readonly #listeners = new Set<(projection: SubagentProjection) => void>()

    constructor(value: SubagentProjection) {
        this.value = value
    }

    read(): SubagentProjection {
        return this.value
    }

    subscribe(listener: (projection: SubagentProjection) => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    emit(value: SubagentProjection): void {
        this.value = value
        for (const listener of [...this.#listeners]) listener(value)
    }

    async activity(): Promise<readonly string[]> {
        return this.activityLines
    }

    watchActivity(
        _id: ConversationId,
        listener: (lines: readonly string[]) => void
    ): () => void {
        listener(this.activityLines)
        return () => {
            this.disposals += 1
        }
    }
}

test('statusFromLive distinguishes a run, a wait_agent block, idle, and terminal outcomes', () => {
    assert.equal(statusFromLive(undefined), 'idle')
    assert.equal(statusFromLive({}), 'idle')
    const running: LiveState = { run: { taskId: 1 as never, inputs: [] } }
    assert.equal(statusFromLive(running), 'running')
    const waiting: LiveState = {
        run: { taskId: 1 as never, inputs: [] },
        tools: [{ callId: 'call', name: 'wait_agent', status: 'running' }],
    }
    assert.equal(statusFromLive(waiting), 'waiting')
    assert.equal(statusFromLive(undefined, 'Completed'), 'completed')
    assert.equal(statusFromLive(undefined, 'Errored'), 'errored')
    assert.equal(statusFromLive(undefined, 'Interrupted'), 'interrupted')
    assert.equal(statusFromLive(undefined), 'idle')
})

test('toProjection counts statuses and nests the tree', () => {
    const live = new Map<ConversationId, LiveState>([
        [conversation(1), { run: { taskId: 1 as never, inputs: [] } }],
        [
            conversation(2),
            {
                run: { taskId: 2 as never, inputs: [] },
                tools: [{ callId: 'c', name: 'wait_agent', status: 'running' }],
            },
        ],
    ])
    const projection = projectionWith(
        [
            input('/root/a', '/root', 1),
            input('/root/a/b', '/root/a', 2),
            input('/root/c', '/root', 3),
        ],
        live
    )
    assert.deepEqual(projection.counts, { total: 3, running: 1, waiting: 1 })
    const tree = agentTree(projection.agents)
    assert.deepEqual(
        tree.map((node) => node.agent.path),
        ['/root/a', '/root/c']
    )
    assert.deepEqual(
        tree[0]?.children.map((node) => node.agent.path),
        ['/root/a/b']
    )
})

test('inspector renders, repaints on updates, scrolls detail, and disposes', async () => {
    const source = new FakeSource(
        projectionWith(
            [
                input('/root/worker', '/root', 1, {
                    role: 'reviewer',
                    model: 'faux/faux-1',
                }),
            ],
            new Map()
        )
    )
    source.activityLines = Array.from(
        { length: 20 },
        (_value, index) => `activity ${index + 1}`
    )
    let renders = 0
    const handle = createSubagentInspector(source, theme, {
        requestRender: () => {
            renders += 1
        },
        maxActivity: 5,
    })

    assert.match(handle.component.render(80).join('\n'), /worker/)
    handle.component.handleInput?.('j')
    assert.ok(renders >= 1, 'input repaints through requestRender')

    handle.component.handleInput?.('\r')
    await Promise.resolve()
    const detail = handle.component.render(80).join('\n')
    assert.match(detail, /activity 1/)
    assert.match(detail, /1-5\/20/)
    handle.component.handleInput?.('j')
    assert.match(handle.component.render(80).join('\n'), /2-6\/20/)

    // An asynchronous projection update repaints.
    source.emit(
        projectionWith(
            [input('/root/worker', '/root', 1, { status: 'completed' })],
            new Map()
        )
    )
    assert.match(handle.component.render(80).join('\n'), /completed/)

    handle.component.handleInput?.('\x1b')
    assert.match(handle.component.render(80).join('\n'), /worker/)
    handle.dispose()
    assert.equal(source.disposals, 1)
})

test('agentTree treats an unknown parent as a root', () => {
    const summary = (
        path: string,
        parentPath: string | null
    ): AgentSummary => ({
        path,
        name: path,
        parentPath,
        status: 'idle',
        conversationId: conversation(1),
        createdAt: 0,
    })
    const tree = agentTree([summary('/root/x', '/root/missing')])
    assert.deepEqual(
        tree.map((node) => node.agent.path),
        ['/root/x']
    )
})
