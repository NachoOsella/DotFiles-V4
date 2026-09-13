import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { ListedAgent } from './src/manager.ts'
import {
    agentDepth,
    buildExpandedLines,
    compactSummary,
    compactTone,
    isSubagentsWidgetDetailed,
    isWidgetCollapsed,
    setSubagentsWidgetDetail,
    setWidgetCollapsed,
    shortAgentName,
    toggleWidgetCollapsed,
} from './src/widget.ts'

const stubTheme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme

function listedAgent(overrides: Partial<ListedAgent> = {}): ListedAgent {
    return {
        path: '/root/worker' as ListedAgent['path'],
        status: 'Running',
        residency: 'loaded',
        model: 'test-model',
        parentPath: '/root' as ListedAgent['parentPath'],
        hasPendingMail: false,
        running: true,
        ...overrides,
    } as ListedAgent
}

test('shortens agent paths below /root', () => {
    assert.equal(shortAgentName('/root'), '/root')
    assert.equal(shortAgentName('/root/worker'), 'worker')
    assert.equal(shortAgentName('/root/worker/nested'), 'worker/nested')
})

test('computes nesting depth below /root', () => {
    assert.equal(agentDepth('/root'), 0)
    assert.equal(agentDepth('/root/worker'), 0)
    assert.equal(agentDepth('/root/worker/nested'), 1)
    assert.equal(agentDepth('/root/a/b/c'), 2)
})

test('widget density toggles between compact and detailed', () => {
    setSubagentsWidgetDetail(false)
    assert.equal(isSubagentsWidgetDetailed(), false)
    setSubagentsWidgetDetail(true)
    assert.equal(isSubagentsWidgetDetailed(), true)
    setSubagentsWidgetDetail(false)
    assert.equal(isSubagentsWidgetDetailed(), false)
})

test('widget collapsed state toggles for the alt+s shortcut', () => {
    setWidgetCollapsed(false)
    assert.equal(isWidgetCollapsed(), false)
    assert.equal(toggleWidgetCollapsed(), true)
    assert.equal(isWidgetCollapsed(), true)
    assert.equal(toggleWidgetCollapsed(), false)
    assert.equal(isWidgetCollapsed(), false)
})

test('compact summary prioritizes running over errored over settled', () => {
    assert.equal(compactSummary(2, 1, 12), '● 2 running')
    assert.equal(compactSummary(0, 1, 12), '! 1 errored')
    assert.equal(compactSummary(0, 0, 12), '✓ 12 settled')
    assert.equal(compactTone(2, 0), 'accent')
    assert.equal(compactTone(0, 1), 'warning')
    assert.equal(compactTone(0, 0), 'muted')
})

test('expanded panel mirrors the stats frame and fits its width', () => {
    const agents = [
        listedAgent(),
        listedAgent({
            path: '/root/worker/nested' as ListedAgent['path'],
            status: 'Completed',
            parentPath: '/root/worker' as ListedAgent['parentPath'],
            running: false,
        }),
        listedAgent({
            path: '/root/other' as ListedAgent['path'],
            status: 'Errored',
            running: false,
        }),
    ]
    for (const width of [40, 24]) {
        const lines = buildExpandedLines(agents, stubTheme, width, false)
        assert.ok(lines.length > 3)
        for (const line of lines) {
            assert.ok(
                visibleWidth(line) <= width,
                `line exceeded width ${width}: ${line}`
            )
        }
        assert.ok(lines[0]?.startsWith('╭') && lines[0]?.endsWith('╮'))
        assert.ok(
            lines[lines.length - 1]?.startsWith('╰') &&
                lines[lines.length - 1]?.endsWith('╯')
        )
        assert.ok(lines.some((line) => line.includes('AGENTS')))
        assert.ok(lines.some((line) => line.includes('1 active')))
        assert.ok(lines.some((line) => line.includes('worker')))
        assert.ok(
            !lines.some((line) => line.includes('alt+s')),
            'footer hint was removed for compactness'
        )
    }
})

test('expanded rows collapse nested agents into a +N indicator', () => {
    const agents = [
        listedAgent(),
        listedAgent({
            path: '/root/worker/nested' as ListedAgent['path'],
            status: 'Running',
            parentPath: '/root/worker' as ListedAgent['parentPath'],
        }),
        listedAgent({
            path: '/root/worker/nested/deep' as ListedAgent['path'],
            status: 'Completed',
            parentPath: '/root/worker/nested' as ListedAgent['parentPath'],
            running: false,
        }),
        listedAgent({
            path: '/root/solo' as ListedAgent['path'],
            status: 'Completed',
            running: false,
        }),
    ]
    const lines = buildExpandedLines(agents, stubTheme, 60, false)
    const text = lines.join('\n')
    assert.ok(!text.includes('nested'), 'nested rows stay collapsed')
    assert.ok(text.includes('solo'), 'childless top-level rows stay')
    assert.ok(
        text.includes('+2 · ●1'),
        'row shows total nested and nested running'
    )
})

test('expanded frame sizes to content instead of terminal width', () => {
    const agents = [
        listedAgent(),
        listedAgent({
            path: '/root/worker/nested' as ListedAgent['path'],
            status: 'Completed',
            parentPath: '/root/worker' as ListedAgent['parentPath'],
            running: false,
        }),
        listedAgent({
            path: '/root/other' as ListedAgent['path'],
            status: 'Errored',
            running: false,
        }),
    ]
    const lines = buildExpandedLines(agents, stubTheme, 120, false)
    const widths = new Set(lines.map((line) => visibleWidth(line)))
    assert.equal(widths.size, 1, 'frame lines share one width')
    assert.ok(
        (lines[0] ? visibleWidth(lines[0]) : 120) < 60,
        `frame should hug content, got: ${lines[0]}`
    )
})

test('settled groups show nested totals without a running marker', () => {
    const agents = [
        listedAgent({
            status: 'Completed',
            running: false,
        }),
        listedAgent({
            path: '/root/worker/nested' as ListedAgent['path'],
            status: 'Completed',
            parentPath: '/root/worker' as ListedAgent['parentPath'],
            running: false,
        }),
    ]
    const text = buildExpandedLines(agents, stubTheme, 60, false).join('\n')
    assert.ok(text.includes('+1'))
    assert.ok(!text.includes('●1'))
})

test('expanded panel shows settled scope when nothing runs', () => {
    const agents = [
        listedAgent({
            status: 'Completed',
            running: false,
        }),
    ]
    const lines = buildExpandedLines(agents, stubTheme, 40, true)
    assert.ok(lines.some((line) => line.includes('1 settled')))
    assert.ok(lines.some((line) => line.includes('test-model')))
})
