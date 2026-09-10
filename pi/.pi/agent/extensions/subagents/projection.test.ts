import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    compactRowText,
    emptyUiState,
    pushActivity,
    reduceUiState,
} from './src/projection.ts'
import type { AgentId, AgentPath } from './src/ids.ts'
import { AgentStatus } from './src/agent-status.ts'

const ID = 'agent-1' as AgentId
const PATH = '/root/worker' as AgentPath

describe('tui projection', () => {
    it('starts empty and shows a running agent', () => {
        let state = emptyUiState()
        assert.equal(state.rows.length, 0)
        state = reduceUiState(state, {
            _tag: 'ActivityStarted',
            callId: 'call-1' as never,
            agentId: ID,
            agentPath: PATH,
            parentTurnId: 'turn-1' as never,
        })
        assert.equal(state.rows.length, 1)
        assert.equal(state.rows[0]!.status, 'Running')
        assert.match(compactRowText(state.rows[0]!), /● \/root\/worker/)
    })

    it('renders terminal states and collapses when settled', () => {
        let state = reduceUiState(emptyUiState(), {
            _tag: 'ActivityStarted',
            callId: 'c1' as never,
            agentId: ID,
            agentPath: PATH,
            parentTurnId: 't1' as never,
        })
        state = reduceUiState(state, {
            _tag: 'StatusChanged',
            agentId: ID,
            previous: AgentStatus.running(),
            current: AgentStatus.completed('done'),
        })
        assert.equal(state.rows[0]!.status, 'Completed')

        const other = 'agent-2' as AgentId
        state = reduceUiState(state, {
            _tag: 'ActivityStarted',
            callId: 'c2' as never,
            agentId: other,
            agentPath: '/root/other' as AgentPath,
            parentTurnId: 't1' as never,
        })
        state = reduceUiState(state, {
            _tag: 'StatusChanged',
            agentId: other,
            previous: AgentStatus.running(),
            current: AgentStatus.errored('boom'),
        })
        assert.ok(state.collapsedSummary?.includes('completed'))
    })

    it('bounds activity summaries', () => {
        let lines = pushActivity([], 'x'.repeat(1000))
        assert.ok(lines[0]!.text.length <= 240)
        for (let i = 0; i < 20; i += 1) {
            lines = pushActivity(lines, `line ${i}`)
        }
        assert.equal(lines.length, 8)
    })
})
