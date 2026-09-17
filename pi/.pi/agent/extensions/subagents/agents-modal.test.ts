import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { AgentRecord } from './src/agent-record.ts'
import type { AgentPath } from './src/ids.ts'
import type { ListedAgent } from './src/manager.ts'
import {
    buildAgentsDashboardLines,
    buildAgentsModalLines,
    collapseRedundant,
    type DashboardState,
    type ModalState,
    type RenderEntry,
} from './src/agents-modal.ts'
import type { ActivityEntry } from './src/activity-feed.ts'

const stubTheme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme

function listedAgent(overrides: Partial<ListedAgent> = {}): ListedAgent {
    return {
        path: '/root/worker' as AgentPath,
        status: 'Running',
        residency: 'loaded',
        model: 'test-model',
        parentPath: '/root' as AgentPath,
        hasPendingMail: false,
        running: true,
        ...overrides,
    } as ListedAgent
}

function state(overrides: Partial<ModalState> = {}): ModalState {
    return { selected: 0, expanded: new Set(), detailed: false, ...overrides }
}

const emptyReader = {
    getRecordByPath: (_path: AgentPath): AgentRecord | undefined => undefined,
}

const dashboardReader = {
    ...emptyReader,
    getActivity: (_path: AgentPath) => [
        {
            id: 1,
            at: Date.now(),
            kind: 'tool' as const,
            summary: 'read path="src/index.ts"',
        },
    ],
}

test('full-screen dashboard fills wide and narrow terminal dimensions', () => {
    const dashboardState: DashboardState = {
        selected: 0,
        focus: 'agents',
        scroll: 0,
        followTail: true,
        narrowPanel: 'agents',
        hiddenKinds: new Set(),
        seenByPath: new Map(),
    }
    for (const [width, height] of [
        [120, 32],
        [70, 20],
    ] as const) {
        const lines = buildAgentsDashboardLines(
            [listedAgent()],
            dashboardReader,
            dashboardState,
            width,
            height,
            stubTheme
        )
        assert.equal(lines.length, height)
        assert.ok(lines.every((line) => visibleWidth(line) === width))
    }
})

test('timeline merges tool completion and drops message shadowed by final', () => {
    const at = Date.now()
    const entry = (
        id: number,
        kind: ActivityEntry['kind'],
        summary: string
    ): ActivityEntry => ({ id, at, kind, summary })
    const collapsed = collapseRedundant([
        entry(1, 'tool', 'write path="/tmp/x"'),
        entry(2, 'tool_result', 'write completed'),
        entry(3, 'message', 'done'),
        entry(4, 'final', 'done'),
        entry(5, 'tool_result', 'grep failed'),
    ])
    assert.equal(collapsed.length, 3)
    assert.equal(collapsed[0]?.kind, 'tool')
    assert.ok(collapsed[0]?.doneAt !== undefined)
    assert.equal(collapsed[1]?.kind, 'final')
    assert.equal(collapsed[2]?.kind, 'tool_result')
})

test('dashboard wraps long stories instead of truncating every line', () => {
    const reader = {
        ...emptyReader,
        getActivity: (_path: AgentPath) => [
            {
                id: 1,
                at: Date.now(),
                kind: 'final' as const,
                summary:
                    'El farero encendía la luz cada noche aunque hacía años que ningún barco pasaba por aquella costa.',
            },
        ],
    }
    const lines = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        {
            selected: 0,
            focus: 'activity',
            scroll: 0,
            followTail: true,
            narrowPanel: 'activity',
            hiddenKinds: new Set(),
            seenByPath: new Map(),
        },
        100,
        20,
        stubTheme
    )
    const body = lines.join('\n')
    assert.ok(body.includes('FINAL'))
    assert.ok(body.includes('aquella costa.'))
    assert.ok(!body.includes('…'))
})

test('tool blocks show shell commands plainly with durations', () => {
    const at = Date.now()
    const reader = {
        ...emptyReader,
        getActivity: (_path: AgentPath): RenderEntry[] => [
            {
                id: 1,
                at,
                kind: 'tool' as const,
                summary: `bash $ printf 'HI/\\n'`,
                doneAt: at + 2500,
            },
            {
                id: 2,
                at,
                kind: 'thinking' as const,
                summary: 'considering the next step',
            },
        ],
    }
    const lines = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        {
            selected: 0,
            focus: 'activity',
            scroll: 0,
            followTail: true,
            narrowPanel: 'activity',
            hiddenKinds: new Set(),
            seenByPath: new Map(),
        },
        100,
        24,
        stubTheme
    )
    const body = lines.join('\n')
    assert.ok(body.includes('bash'))
    assert.ok(body.includes(`$ printf`))
    assert.ok(!body.includes('command='))
    assert.ok(!body.includes('\\\\n'))
    assert.match(body, /done in 2s/)
    assert.ok(body.includes('THINK'))
    assert.ok(body.includes('│'))
})

test('agent rows show status, thinking and elapsed without truncation', () => {
    const reader = {
        getRecordByPath: (_path: AgentPath) =>
            ({
                thinkingLevel: 'xhigh',
                lastActivityAt: Date.now(),
                model: 'opencode/muse-spark-1.3-contributor-free',
            }) as unknown as AgentRecord,
        getActivity: (_path: AgentPath): ActivityEntry[] => [],
    }
    const lines = buildAgentsDashboardLines(
        [
            listedAgent({
                path: '/root/tool_subagente_uno' as AgentPath,
                status: 'Completed',
                running: false,
            }),
        ],
        reader,
        {
            selected: 0,
            focus: 'agents',
            scroll: 0,
            followTail: true,
            narrowPanel: 'agents',
            hiddenKinds: new Set(),
            seenByPath: new Map(),
        },
        120,
        24,
        stubTheme
    )
    const body = lines.join('\n')
    assert.ok(body.includes('tool_subagente_uno'))
    assert.match(body, /Completed · xhigh/)
    assert.ok(body.includes('muse-spark-1.3-contributor-free'))
    assert.ok(!body.includes('…'))
})

test('dashboard pins the spawn prompt above the activity', () => {
    const reader = {
        getRecordByPath: (_path: AgentPath) =>
            ({
                thinkingLevel: 'xhigh',
                lastActivityAt: Date.now(),
                model: 'opencode/muse-spark',
                task: 'Cuéntame una historia breve y original',
            }) as unknown as AgentRecord,
        getActivity: (_path: AgentPath): ActivityEntry[] => [
            {
                id: 1,
                at: Date.now(),
                kind: 'final' as const,
                summary: 'done',
            },
        ],
    }
    const dashboard: DashboardState = {
        selected: 0,
        focus: 'activity',
        scroll: 0,
        followTail: true,
        narrowPanel: 'activity',
        hiddenKinds: new Set(),
        seenByPath: new Map(),
    }
    const lines = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboard,
        100,
        24,
        stubTheme
    )
    const body = lines.join('\n')
    const taskIndex = body.indexOf('◆ TASK')
    const finalIndex = body.indexOf('FINAL')
    assert.ok(taskIndex >= 0)
    assert.ok(finalIndex > taskIndex)
    assert.ok(body.includes('Cuéntame una historia breve y original'))

    const withoutTask = buildAgentsDashboardLines(
        [listedAgent()],
        dashboardReader,
        { ...dashboard, seenByPath: new Map() },
        100,
        24,
        stubTheme
    )
    assert.ok(!withoutTask.join('\n').includes('◆ TASK'))
})

test('every modal line spans the full width (no terminal ghosting)', () => {
    const agents = [
        listedAgent(),
        listedAgent({
            path: '/root/worker/nested' as AgentPath,
            status: 'Completed',
            parentPath: '/root/worker' as AgentPath,
            running: false,
        }),
        listedAgent({
            path: '/root/other' as AgentPath,
            status: 'Errored',
            parentPath: '/root' as AgentPath,
            running: false,
        }),
    ]
    for (const width of [40, 62]) {
        const lines = buildAgentsModalLines(
            agents,
            emptyReader,
            state(),
            width,
            stubTheme
        )
        assert.ok(lines.length > 5)
        for (const line of lines) {
            assert.equal(
                visibleWidth(line),
                width,
                `line is not full width ${width}: ${line}`
            )
        }
    }
})

test('modal frame carries stats chrome and selection', () => {
    const agents = [listedAgent(), listedAgent()]
    const lines = buildAgentsModalLines(
        agents,
        emptyReader,
        state({ selected: 1 }),
        62,
        stubTheme
    )
    assert.ok(lines[0]?.startsWith('╭') && lines[0]?.endsWith('╮'))
    assert.ok(
        lines[lines.length - 1]?.startsWith('╰') &&
            lines[lines.length - 1]?.endsWith('╯')
    )
    assert.ok(lines.some((line) => line.includes('SUBAGENTS')))
    assert.ok(lines.some((line) => line.includes('2 total')))
    assert.ok(lines.some((line) => line.includes('▸')))
    assert.ok(lines.some((line) => line.includes('worker')))
    assert.ok(
        lines.some((line) => line.includes('j/k move')),
        'footer hints are visible'
    )
})

test('expanded rows show record detail inside the frame', () => {
    const agents = [listedAgent()]
    const reader = {
        getRecordByPath: (_path: AgentPath) =>
            ({
                usage: {
                    provider: 'test',
                    modelId: 'test-model',
                    input: 100,
                    output: 50,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0.02,
                    userMessages: 1,
                    assistantMessages: 2,
                    toolResults: 1,
                    toolCalls: [{ name: 'bash', count: 3 }],
                },
                status: { _tag: 'Running' },
                lastActivityAt: Date.now(),
            }) as unknown as AgentRecord,
        getRecentTurns: (_path: AgentPath) =>
            Array.from({ length: 12 }, (_, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                text: `turn ${index + 1}`,
            })).slice(-10),
    }
    const lines = buildAgentsModalLines(
        agents,
        reader,
        state({ expanded: new Set(['/root/worker']) }),
        62,
        stubTheme
    )
    for (const line of lines) {
        assert.equal(visibleWidth(line), 62)
    }
    assert.ok(lines.some((line) => line.includes('bash×3')))
    assert.ok(lines.some((line) => line.includes('test-model')))
    assert.ok(lines.some((line) => line.includes('last 10 turns')))
    assert.ok(lines.some((line) => line.includes('turn 3')))
    assert.ok(lines.some((line) => line.includes('turn 12')))
    assert.ok(!lines.some((line) => line.includes('turn 2')))
})
