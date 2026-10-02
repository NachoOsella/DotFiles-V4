import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { ListedAgent } from '../core/coordinator.ts'
import {
    agentDepth,
    buildAgentsDashboardLines,
    collapseRedundant,
    type DashboardState,
    shortAgentName,
    type RenderEntry,
} from './agents-modal.ts'
import type { ActivityEntry } from './activity-feed.ts'

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
        waiting: false,
        ...overrides,
    } as ListedAgent
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
        taskExpanded: false,
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

test('timeline pairs look-alike parallel calls by call id', () => {
    const at = Date.now()
    const entry = (
        id: number,
        kind: ActivityEntry['kind'],
        summary: string,
        toolCallId?: string
    ): ActivityEntry => ({ id, at, kind, summary, toolCallId })
    const collapsed = collapseRedundant([
        entry(1, 'tool', 'read path="a"', 'call-1'),
        entry(2, 'tool', 'read path="b"', 'call-2'),
        entry(3, 'tool_result', 'read completed', 'call-2'),
        entry(4, 'tool_result', 'read completed', 'call-1'),
    ])

    assert.equal(collapsed.length, 2)
    assert.equal(collapsed[0]?.summary, 'read path="a"')
    assert.ok(collapsed[0]?.doneAt !== undefined)
    assert.equal(collapsed[1]?.summary, 'read path="b"')
    assert.ok(collapsed[1]?.doneAt !== undefined)
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
            taskExpanded: false,
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
            taskExpanded: false,
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

test('nested tool calls are marked in the timeline', () => {
    const at = Date.now()
    const reader = {
        ...emptyReader,
        getActivity: (_path: AgentPath): RenderEntry[] => [
            {
                id: 1,
                at,
                kind: 'tool' as const,
                summary: 'codemode',
                doneAt: at + 900,
            },
            {
                id: 2,
                at,
                kind: 'tool' as const,
                summary: 'read path="src/index.ts"',
                toolCallId: 'call-1',
                nested: true,
                doneAt: at + 400,
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
            taskExpanded: false,
            seenByPath: new Map(),
        },
        100,
        24,
        stubTheme
    )
    const body = lines.join('\n')
    assert.ok(body.includes('codemode'))
    assert.equal(body.match(/nested/g)?.length, 1)
    assert.match(body, /read.*nested/)
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
            taskExpanded: false,
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
        taskExpanded: false,
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

test('clamps long spawn prompts until t expands them', () => {
    const task = Array.from(
        { length: 12 },
        (_, index) => `task line ${index + 1}`
    ).join('\n')
    const reader = {
        getRecordByPath: (_path: AgentPath) =>
            ({ task }) as unknown as AgentRecord,
        getActivity: (_path: AgentPath): ActivityEntry[] => [
            {
                id: 1,
                at: Date.now(),
                kind: 'final' as const,
                summary: 'done',
            },
        ],
    }
    const collapsed = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor(),
        100,
        24,
        stubTheme
    ).join('\n')
    assert.ok(collapsed.includes('task line 5'))
    assert.ok(!collapsed.includes('task line 6'))
    assert.match(collapsed, /\+7 more lines/)
    assert.ok(collapsed.includes('FINAL'))

    const expanded = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor({ taskExpanded: true }),
        100,
        24,
        stubTheme
    ).join('\n')
    assert.ok(expanded.includes('task line 12'))
})

test('shortens agent paths below /root', () => {
    assert.equal(shortAgentName('/root'), '/root')
    assert.equal(shortAgentName('/root/worker'), 'worker')
    assert.equal(shortAgentName('/root/worker/nested'), 'worker/nested')
})

test('computes nesting depth below /root', () => {
    assert.equal(agentDepth('/root'), 0)
    assert.equal(agentDepth('/root/worker'), 0)
    assert.equal(agentDepth('/root/worker/nested'), 1)
    assert.equal(agentDepth('/root/worker/nested/deep'), 2)
})

function dashboardStateFor(
    overrides: Partial<DashboardState> = {}
): DashboardState {
    return {
        selected: 0,
        focus: 'activity',
        scroll: 0,
        followTail: true,
        narrowPanel: 'activity',
        hiddenKinds: new Set(),
        taskExpanded: false,
        seenByPath: new Map(),
        ...overrides,
    }
}

test('activity panel notes which kinds are hidden', () => {
    const reader = {
        ...emptyReader,
        getActivity: (_path: AgentPath): RenderEntry[] => [
            { id: 1, at: Date.now(), kind: 'tool' as const, summary: 'read' },
        ],
    }
    const lines = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor({ hiddenKinds: new Set(['thinking', 'message']) }),
        100,
        24,
        stubTheme
    )
    assert.match(lines.join('\n'), /hidden: thinking,message/)
})

test('narrow dashboards use the compact key hint', () => {
    const reader = { ...emptyReader, getActivity: () => [] }
    const narrow = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor(),
        60,
        24,
        stubTheme
    ).join('\n')
    assert.match(narrow, /1-5/)
    assert.ok(!narrow.includes('top/bottom'))

    const wide = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor(),
        120,
        24,
        stubTheme
    ).join('\n')
    assert.match(wide, /top\/bottom/)
})

test('failed tools show the error text, not a bare failure', () => {
    const reader = {
        ...emptyReader,
        getActivity: (_path: AgentPath): RenderEntry[] => [
            {
                id: 1,
                at: Date.now(),
                kind: 'tool_result' as const,
                summary: 'read failed: ENOENT: no such file',
            },
        ],
    }
    const body = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor(),
        100,
        24,
        stubTheme
    ).join('\n')
    assert.match(body, /FAILED/)
    assert.match(body, /ENOENT: no such file/)
    assert.ok(!body.includes('read failed: ENOENT'))
})

test('waiting agents are marked in the list', () => {
    const reader = { ...emptyReader, getActivity: () => [] }
    const body = buildAgentsDashboardLines(
        [listedAgent({ waiting: true })],
        reader,
        dashboardStateFor({ focus: 'agents', narrowPanel: 'agents' }),
        100,
        24,
        stubTheme
    ).join('\n')
    assert.match(body, /waiting/)
    assert.match(body, /◐/)
})

test('settled agents without activity show their last turns', () => {
    const reader = {
        ...emptyReader,
        getActivity: () => [],
        getRecentTurns: () => [
            { role: 'user', text: 'do the thing' },
            { role: 'assistant', text: 'did the thing' },
        ],
    }
    const body = buildAgentsDashboardLines(
        [listedAgent({ status: 'Completed', running: false })],
        reader,
        dashboardStateFor(),
        100,
        24,
        stubTheme
    ).join('\n')
    assert.match(body, /last turns/)
    assert.match(body, /do the thing/)
    assert.ok(!body.includes('No activity yet.'))
})

test('the selected agent subtitle carries tokens and cost', () => {
    const reader = {
        ...emptyReader,
        getRecordByPath: (_path: AgentPath) =>
            ({
                thinkingLevel: 'high',
                model: 'provider/model',
                usage: {
                    provider: 'provider',
                    modelId: 'model',
                    input: 1200,
                    output: 300,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0.0123,
                    userMessages: 1,
                    assistantMessages: 1,
                    toolResults: 0,
                    toolCalls: [],
                },
            }) as unknown as AgentRecord,
        getActivity: () => [],
    }
    const body = buildAgentsDashboardLines(
        [listedAgent()],
        reader,
        dashboardStateFor(),
        100,
        24,
        stubTheme
    ).join('\n')
    assert.match(body, /1\.5K tok/)
    assert.match(body, /\$0\.0123/)
})
