/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/core/src/session_prefix.rs
 *
 * Terminal results become FINAL_ANSWER payloads. Pending/running/
 * interrupted statuses produce no completion message. Errors are
 * bounded (~1000 tokens total) with recovery guidance.
 */

import type { AgentStatus } from './agent-status.ts'

const MAX_ERROR_CHARS = 3_200
const ENVELOPE_RESERVE_CHARS = 800

function truncateError(error: string): string {
    const budget = Math.max(0, MAX_ERROR_CHARS - ENVELOPE_RESERVE_CHARS)
    const trimmed = error.trim()
    if (trimmed.length <= budget) return trimmed
    return `${trimmed.slice(0, budget)}… [truncated ${trimmed.length - budget} chars]`
}

/**
 * Format a terminal status as a FINAL_ANSWER payload.
 * Returns null when the status is not terminal-result-bearing.
 */
export function formatFinalAnswer(status: AgentStatus): string | null {
    switch (status._tag) {
        case 'Completed':
            return status.message ?? ''
        case 'Errored':
            return `Agent errored: ${truncateError(status.error)}\nYou may retry with followup_task using a narrower task, or inspect the failure and continue.`
        default:
            return null
    }
}
