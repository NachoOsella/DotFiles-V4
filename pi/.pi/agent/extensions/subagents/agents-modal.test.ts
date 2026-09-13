import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { AgentRecord } from './src/agent-record.ts'
import type { AgentPath } from './src/ids.ts'
import type { ListedAgent } from './src/manager.ts'
import { buildAgentsModalLines, type ModalState } from './src/agents-modal.ts'

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
})
