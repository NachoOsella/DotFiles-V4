import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AgentStatus, isFinalStatus } from './src/agent-status.ts'
import { statusFromAgentEvent } from './src/status-reducer.ts'

describe('status reducer', () => {
    it('moves PendingInit to Running on turn start', () => {
        const next = statusFromAgentEvent(AgentStatus.pendingInit(), {
            _tag: 'TurnStarted',
        })
        assert.deepEqual(next, AgentStatus.running())
    })

    it('completes with and without a final message', () => {
        assert.deepEqual(
            statusFromAgentEvent(AgentStatus.running(), {
                _tag: 'TurnComplete',
                lastMessage: 'done',
            }),
            AgentStatus.completed('done')
        )
        assert.deepEqual(
            statusFromAgentEvent(AgentStatus.running(), {
                _tag: 'TurnComplete',
                lastMessage: null,
            }),
            AgentStatus.completed(null)
        )
    })

    it('records failures and interruptions', () => {
        assert.deepEqual(
            statusFromAgentEvent(AgentStatus.running(), {
                _tag: 'TurnFailed',
                error: 'boom',
            }),
            AgentStatus.errored('boom')
        )
        assert.deepEqual(
            statusFromAgentEvent(AgentStatus.running(), {
                _tag: 'TurnInterrupted',
            }),
            AgentStatus.interrupted()
        )
        assert.deepEqual(
            statusFromAgentEvent(AgentStatus.running(), {
                _tag: 'TurnAbortedBudget',
            }),
            AgentStatus.interrupted()
        )
        assert.deepEqual(
            statusFromAgentEvent(AgentStatus.running(), {
                _tag: 'RuntimeShutdown',
            }),
            AgentStatus.shutdown()
        )
    })

    it('treats Interrupted as non-final so followup can restart', () => {
        assert.equal(isFinalStatus(AgentStatus.interrupted()), false)
        assert.equal(isFinalStatus(AgentStatus.pendingInit()), false)
        assert.equal(isFinalStatus(AgentStatus.running()), false)
        assert.equal(isFinalStatus(AgentStatus.completed('x')), true)
        assert.equal(isFinalStatus(AgentStatus.errored('x')), true)
        assert.equal(isFinalStatus(AgentStatus.shutdown()), true)
    })

    it('never lets a trailing empty completion erase a terminal error', () => {
        const next = statusFromAgentEvent(AgentStatus.errored('boom'), {
            _tag: 'TurnComplete',
            lastMessage: null,
        })
        assert.equal(next, null)
    })
})
