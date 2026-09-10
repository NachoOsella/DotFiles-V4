/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/core/src/agent/status.rs
 *
 * Pure event-to-status reducer. Keep it free of I/O so parity tests
 * never need a model integration.
 */

import { AgentStatus, type AgentStatus as Status } from './agent-status.ts'

/** Minimal turn events the reducer understands. */
export type AgentTurnEvent =
    | { readonly _tag: 'TurnStarted' }
    | { readonly _tag: 'TurnComplete'; readonly lastMessage: string | null }
    | { readonly _tag: 'TurnFailed'; readonly error: string }
    | { readonly _tag: 'TurnInterrupted' }
    | { readonly _tag: 'TurnAbortedBudget' }
    | { readonly _tag: 'RuntimeShutdown' }

/**
 * Reduce one turn event onto the current status.
 * Returns null when the event causes no transition.
 * Terminal error precedence: a trailing empty completion never erases
 * an already-recorded terminal failure; callers must not apply a
 * TurnComplete over Errored without an intervening new turn.
 */
export function statusFromAgentEvent(
    current: Status,
    event: AgentTurnEvent
): Status | null {
    switch (event._tag) {
        case 'TurnStarted':
            if (current._tag === 'Running') return null
            return AgentStatus.running()
        case 'TurnComplete':
            if (current._tag === 'Errored') return null
            return AgentStatus.completed(event.lastMessage)
        case 'TurnFailed':
            return AgentStatus.errored(event.error)
        case 'TurnInterrupted':
        case 'TurnAbortedBudget':
            if (current._tag === 'Shutdown') return null
            return AgentStatus.interrupted()
        case 'RuntimeShutdown':
            return AgentStatus.shutdown()
    }
}
