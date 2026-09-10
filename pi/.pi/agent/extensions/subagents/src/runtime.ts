/**
 * Async entry-point boundary. The manager is a plain session-scoped class
 * (deliberate simplification; see docs/ARCHITECTURE.md); this module is
 * the single place where Effect meets Pi's async tool contract.
 *
 * Typed failures and defects become thrown Errors; AbortSignal
 * interruption throws `interruptMessage`.
 */

import { Cause, Effect, Exit } from 'effect'
import {
    DEFAULT_SUBAGENTS_CONFIG,
    type CodexSubagentsConfig,
} from './config.ts'
import type { PiHost } from './host.ts'
import { SubagentManager } from './manager.ts'

export function createSubagentRuntime(
    host: PiHost,
    config: CodexSubagentsConfig = DEFAULT_SUBAGENTS_CONFIG
) {
    const manager = new SubagentManager(host, config)
    return { manager }
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>

/** Run an Effect from an async tool handler with Pi-friendly errors. */
export async function runTool<A, E>(
    effect: Effect.Effect<A, E>,
    options: { signal?: AbortSignal; interruptMessage?: string } = {}
): Promise<A> {
    const exit = await Effect.runPromiseExit(
        effect,
        options.signal ? { signal: options.signal } : undefined
    )
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasInterruptsOnly(exit.cause)) {
        throw new Error(options.interruptMessage ?? 'Operation was aborted.')
    }
    const first = Cause.prettyErrors(exit.cause)[0]
    throw new Error(first?.message ?? Cause.pretty(exit.cause))
}
