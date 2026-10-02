/**
 * Pure inter-agent protocol values.
 *
 * Three model-visible message types: NEW_TASK, MESSAGE, FINAL_ANSWER. The
 * envelope is the only shape written into a conversation for agent
 * communication.
 */

import { ROOT_PATH, type AgentPath } from './agent-path.js'

export type InterAgentMessageType = 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER'

/** How much parent history a child inherits. */
export type ForkTurns =
    | { readonly kind: 'all' }
    | { readonly kind: 'none' }
    | { readonly kind: 'recent'; readonly turns: number }

export class InvalidForkTurnsError extends Error {
    readonly _tag = 'InvalidForkTurns'
    readonly value: string

    constructor(value: string) {
        super(
            `Invalid fork_turns "${value}": use "all", "none", or a positive integer N.`
        )
        this.name = 'InvalidForkTurnsError'
        this.value = value
    }
}

/**
 * Parse `fork_turns` exactly: omitted/blank/`all` yields the full history,
 * `none` a fresh context, and a positive integer N the most recent N logical
 * turns. `0` and anything unrecognized are invalid.
 */
export function parseForkTurns(value?: string): ForkTurns {
    if (value === undefined) return { kind: 'all' }
    const trimmed = value.trim()
    if (trimmed === '') return { kind: 'all' }
    const lowered = trimmed.toLowerCase()
    if (lowered === 'all') return { kind: 'all' }
    if (lowered === 'none') return { kind: 'none' }
    if (/^\d+$/.test(trimmed)) {
        const turns = Number.parseInt(trimmed, 10)
        if (!Number.isSafeInteger(turns) || turns <= 0) {
            throw new InvalidForkTurnsError(value)
        }
        return { kind: 'recent', turns }
    }
    throw new InvalidForkTurnsError(value)
}

/**
 * Render the canonical model-visible envelope shared by every communication
 * type.
 */
export function formatEnvelope(
    type: InterAgentMessageType,
    taskName: string,
    sender: string,
    payload: string
): string {
    return [
        `Message Type: ${type}`,
        `Task name: ${taskName}`,
        `Sender: ${sender}`,
        'Payload:',
        payload,
    ].join('\n')
}

/** Short display name for one path: its last segment, or `/root`. */
export function displayNameFor(path: AgentPath): string {
    if (path === ROOT_PATH) return ROOT_PATH
    const index = path.lastIndexOf('/')
    return index < 0 ? path : path.slice(index + 1)
}
