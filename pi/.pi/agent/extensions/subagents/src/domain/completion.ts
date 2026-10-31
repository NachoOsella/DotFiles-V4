/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/core/src/session_prefix.rs
 *
 * Terminal results become FINAL_ANSWER payloads. Pending/running/
 * interrupted statuses produce no completion message. Successful and
 * failed payloads are bounded and carry a reference to the child
 * transcript that keeps the full text; bounding never changes stored
 * transcript content.
 */

import type { AgentStatus } from './agent-status.ts'

/** Target ceiling for one model-visible completion payload. */
const MAX_RESULT_CHARS = 4_000
/** Room for the truncation marker and an inline transcript reference. */
const RESULT_RESERVE_CHARS = 800
/**
 * Longest reference inlined in the payload. Longer paths stay only in
 * `fullResultRef` metadata so the payload never embeds a truncated, fake path.
 */
const INLINE_REFERENCE_MAX_CHARS = 200
const MAX_ERROR_CHARS = 3_200
const ENVELOPE_RESERVE_CHARS = 800

const EMPTY_SUCCESS =
    'Agent completed a turn with no final message. Use followup_task to request a summary.'

/** Call-site context for a terminal completion payload. */
export interface FinalAnswerContext {
    /** Native child session file that retains the full transcript. */
    readonly sessionFile?: string
}

export interface CompletionResultInput extends FinalAnswerContext {
    readonly status: AgentStatus
    /** Accepted for callers that have it; not retrievable by the model. */
    readonly sessionId?: string
}

/** Structured completion payload plus bounded-result metadata. */
export interface FormattedCompletionResult {
    /** Nonempty, bounded, model-visible result text. */
    readonly payload: string
    /** True when the stored text was longer than the payload budget. */
    readonly truncated: boolean
    /** Stable child transcript reference, never a second copy of the text. */
    readonly fullResultRef?: string
}

/**
 * Format a terminal status as a FINAL_ANSWER payload.
 * Returns null when the status is not terminal-result-bearing.
 */
export function formatFinalAnswer(
    status: AgentStatus,
    context?: FinalAnswerContext
): string | null {
    return format(status, context)?.payload ?? null
}

/** Format a terminal status with explicit bounded-result metadata. */
export function formatCompletionResult(
    input: CompletionResultInput
): FormattedCompletionResult | null {
    return format(input.status, input)
}

function format(
    status: AgentStatus,
    context: FinalAnswerContext | undefined
): FormattedCompletionResult | null {
    const ref = context?.sessionFile
    switch (status._tag) {
        case 'Completed': {
            const text = status.message?.trim() ?? ''
            if (text.length === 0) {
                return {
                    payload: `${EMPTY_SUCCESS}${referenceSuffix(ref)}`,
                    truncated: false,
                    ...(ref ? { fullResultRef: ref } : {}),
                }
            }
            const bounded = bound(
                text,
                MAX_RESULT_CHARS - RESULT_RESERVE_CHARS,
                ref
            )
            return {
                payload: bounded.text,
                truncated: bounded.truncated,
                ...(bounded.truncated && ref ? { fullResultRef: ref } : {}),
            }
        }
        case 'Errored': {
            const guidance =
                'You may retry with followup_task using a narrower task, or inspect the failure and continue.'
            const bounded = bound(
                status.error.trim(),
                MAX_ERROR_CHARS - ENVELOPE_RESERVE_CHARS,
                ref
            )
            return {
                payload: `Agent errored: ${bounded.text}\n${guidance}`,
                truncated: bounded.truncated,
                ...(bounded.truncated && ref ? { fullResultRef: ref } : {}),
            }
        }
        default:
            return null
    }
}

function inlineReference(ref: string | undefined): string | undefined {
    return ref && ref.length <= INLINE_REFERENCE_MAX_CHARS ? ref : undefined
}

function referenceSuffix(ref: string | undefined): string {
    if (!ref) return ' The full transcript was not available to this delivery.'
    const inline = inlineReference(ref)
    return inline
        ? ` Full transcript: ${inline}.`
        : ' The full transcript reference is in the result metadata.'
}

/** Cut text without leaving half of a surrogate pair at the boundary. */
function safeSlice(text: string, end: number): string {
    if (end >= text.length) return text
    const last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
        const next = text.charCodeAt(end)
        if (next >= 0xdc00 && next <= 0xdfff) return text.slice(0, end - 1)
    }
    return text.slice(0, end)
}

function bound(
    text: string,
    budget: number,
    ref: string | undefined
): { readonly text: string; readonly truncated: boolean } {
    if (text.length <= budget) return { text, truncated: false }
    const kept = safeSlice(text, budget)
    const omitted = text.length - kept.length
    const inline = inlineReference(ref)
    const marker = inline
        ? `… [truncated ${omitted} chars; full transcript: ${inline}]`
        : ref
          ? `… [truncated ${omitted} chars; full transcript reference in result metadata]`
          : `… [truncated ${omitted} chars; full transcript unavailable]`
    return { text: `${kept}${marker}`, truncated: true }
}
