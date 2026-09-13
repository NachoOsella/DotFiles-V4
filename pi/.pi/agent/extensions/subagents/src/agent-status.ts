/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/protocol/src/protocol.rs (AgentStatus)
 * codex-rs/core/src/agent/status.rs (status reducer semantics)
 *
 * Public statuses are exactly: PendingInit, Running, Interrupted,
 * Completed, Errored, Shutdown, NotFound. Never add queued/blocked/
 * waiting/cancelling as lifecycle states.
 */

export type AgentStatus =
    | { readonly _tag: 'PendingInit' }
    | { readonly _tag: 'Running' }
    | { readonly _tag: 'Interrupted' }
    | { readonly _tag: 'Completed'; readonly message: string | null }
    | { readonly _tag: 'Errored'; readonly error: string }
    | { readonly _tag: 'Shutdown' }
    | { readonly _tag: 'NotFound' }

export const AgentStatus = {
    pendingInit(): AgentStatus {
        return { _tag: 'PendingInit' }
    },
    running(): AgentStatus {
        return { _tag: 'Running' }
    },
    interrupted(): AgentStatus {
        return { _tag: 'Interrupted' }
    },
    completed(message: string | null): AgentStatus {
        return { _tag: 'Completed', message }
    },
    errored(error: string): AgentStatus {
        return { _tag: 'Errored', error }
    },
    shutdown(): AgentStatus {
        return { _tag: 'Shutdown' }
    },
    notFound(): AgentStatus {
        return { _tag: 'NotFound' }
    },
}

/**
 * Interrupted is deliberately NOT terminal: the agent keeps its identity
 * and can receive followup_task. Only states outside PendingInit/Running/
 * Interrupted are final for the current turn.
 */
export function isFinalStatus(status: AgentStatus): boolean {
    return (
        status._tag !== 'PendingInit' &&
        status._tag !== 'Running' &&
        status._tag !== 'Interrupted'
    )
}

/** Residency is a second dimension, never a public Codex status. */
export type AgentResidency = 'unloaded' | 'loading' | 'loaded'
