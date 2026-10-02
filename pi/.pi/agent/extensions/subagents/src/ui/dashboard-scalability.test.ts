import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import type { AgentRecord } from '../domain/agent-record.ts'
import type { ActivityEntry } from './activity-feed.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { ListedAgent } from '../core/coordinator.ts'
import {
    buildAgentsDashboardLines,
    collapseRedundant,
    type DashboardState,
} from './agents-modal.ts'

const stubTheme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme

const AGENT = {
    path: '/root/worker' as AgentPath,
    status: 'Running',
    residency: 'loaded',
    model: 'test-model',
    parentPath: '/root' as AgentPath,
    hasPendingMail: false,
    running: true,
    waiting: false,
} as ListedAgent

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

function entry(
    id: number,
    kind: ActivityEntry['kind'],
    summary: string,
    toolCallId?: string
): ActivityEntry {
    return { id, at: Date.now(), kind, summary, toolCallId }
}

function messages(count: number): ActivityEntry[] {
    return Array.from({ length: count }, (_, index) =>
        entry(index + 1, 'message', `MMMM-${index}-END`)
    )
}

function render(
    entries: readonly ActivityEntry[],
    state: DashboardState,
    width: number,
    height: number
): string {
    const reader = {
        getRecordByPath: (_path: AgentPath): AgentRecord | undefined =>
            undefined,
        getActivity: (_path: AgentPath) => entries,
    }
    return buildAgentsDashboardLines(
        [AGENT],
        reader,
        state,
        width,
        height,
        stubTheme
    ).join('\n')
}

test('long timelines render only the trailing window', () => {
    const body = render(messages(400), dashboardStateFor(), 100, 12)
    assert.ok(body.includes('MMMM-399-END'))
    assert.ok(!body.includes('MMMM-0-END'))
    assert.ok(!body.includes('MMMM-200-END'))
    assert.equal(body.split('\n').length, 12)
})

test('scrolling maps rows from the bottom', () => {
    const entries = messages(20)
    const atTail = render(entries, dashboardStateFor(), 100, 14)
    assert.ok(atTail.includes('MMMM-19-END'))
    assert.ok(!atTail.includes('MMMM-16-END'))

    const shifted = render(
        entries,
        dashboardStateFor({ scroll: 3, followTail: false }),
        100,
        14
    )
    assert.ok(shifted.includes('MMMM-16-END'))
    assert.ok(!shifted.includes('MMMM-19-END'))
})

test('scrolling past the oldest entry clamps to the top', () => {
    const state = dashboardStateFor({ scroll: 1000, followTail: false })
    const body = render(messages(20), state, 100, 14)
    assert.equal(state.scroll, 51)
    assert.ok(body.includes('MMMM-0-END'))
    assert.ok(!body.includes('MMMM-3-END'))
})

test('tool identities stay paired across a long timeline', () => {
    const filler = messages(200).map((item, index) => ({
        ...item,
        id: index + 10,
    }))
    const collapsed = collapseRedundant([
        entry(1, 'tool', 'read path="a"', 'call-1'),
        entry(2, 'tool', 'read path="b"', 'call-2'),
        ...filler,
        entry(300, 'tool_result', 'read completed', 'call-2'),
        entry(301, 'tool_result', 'read completed', 'call-1'),
    ])
    const first = collapsed.find((item) => item.summary === 'read path="a"')
    const second = collapsed.find((item) => item.summary === 'read path="b"')
    assert.ok(first?.doneAt !== undefined)
    assert.ok(second?.doneAt !== undefined)
    assert.equal(
        collapsed.filter((item) => item.kind === 'tool_result').length,
        0
    )
})

test('orphan tool results keep failures and drop bare completions', () => {
    const collapsed = collapseRedundant([
        entry(1, 'tool_result', 'read completed', 'missing'),
        entry(2, 'tool_result', 'read failed: ENOENT: no such file'),
        entry(3, 'tool', 'read path="x"', 'call-9'),
        entry(4, 'tool_result', 'read completed', 'missing-2'),
    ])
    assert.equal(collapsed.length, 2)
    assert.equal(collapsed[0]?.summary, 'read failed: ENOENT: no such file')
    assert.equal(collapsed[1]?.summary, 'read path="x"')
    assert.equal(collapsed[1]?.doneAt, undefined)
})

test('error details survive a long timeline', () => {
    const body = render(
        [
            ...messages(300),
            entry(
                1000,
                'tool_result',
                'bash failed: command not found: frobnicate'
            ),
        ],
        dashboardStateFor(),
        100,
        14
    )
    assert.match(body, /FAILED/)
    assert.match(body, /command not found: frobnicate/)
})

test('rendering long unicode summaries keeps whole code points', () => {
    const body = render(
        [entry(1, 'final', '\u{10400}'.repeat(200))],
        dashboardStateFor(),
        60,
        30
    )
    assert.equal(hasLoneSurrogate(body), false)
    assert.ok(body.includes('\u{10400}'))
})

function hasLoneSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true
            index++
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true
        }
    }
    return false
}
