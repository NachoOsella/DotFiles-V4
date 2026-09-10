/**
 * Pi host boundary. The core depends on this interface, never on Pi
 * objects directly. host-live.ts is the only file allowed to know Pi's
 * concrete session interfaces.
 *
 * Semantic contract (see docs/PI_API_BINDINGS.md):
 * - independent child session creation/resume
 * - model turn invocation + abort
 * - conversation message insertion (NEW_TASK/MESSAGE/FINAL_ANSWER)
 * - streaming/tool event observation (for TUI only)
 * - cwd + model snapshots for spawn inheritance
 */

import type { AgentPath } from './ids.ts'
import type { ForkTurns } from './communication.ts'

export interface HostSessionHandle {
    readonly handleId: string
    /** Durable id suitable for persistence/resume. */
    readonly persistedId: string
    /** Seed history for fork verification in tests. */
    readonly forkMessages: readonly string[]
}

export interface HostTurnResult {
    /** Last assistant text, or null when the turn produced none. */
    readonly lastMessage: string | null
}

export interface HostModelSnapshot {
    readonly provider: string
    readonly id: string
    readonly name?: string
}

export interface PiHost {
    readonly getCwd: () => Promise<string>
    readonly getModel: () => Promise<HostModelSnapshot>
    readonly createSession: (options: {
        agentPath: AgentPath
        fork: ForkTurns
        parentHistory: readonly string[]
        model?: string
        reasoningEffort?: string
        role?: string
    }) => Promise<HostSessionHandle>
    readonly runTurn: (
        session: HostSessionHandle,
        input: string,
        signal: AbortSignal
    ) => Promise<HostTurnResult>
    readonly interruptTurn: (session: HostSessionHandle) => Promise<void>
    readonly getUsage: (session: HostSessionHandle) => Promise<SessionUsage>
    readonly closeSession: (session: HostSessionHandle) => Promise<void>
    readonly appendMessage: (
        session: HostSessionHandle,
        text: string
    ) => Promise<void>
}

/** Named tool-call counter reported by a child session. */
export interface SessionToolCallCount {
    readonly name: string
    readonly count: number
}

/** Cumulative usage of one child session (plain data, safe to persist). */
export interface SessionUsage {
    readonly provider: string
    readonly modelId: string
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly cost: number
    readonly userMessages: number
    readonly assistantMessages: number
    readonly toolResults: number
    readonly toolCalls: ReadonlyArray<SessionToolCallCount>
}

/** Zero usage with an explicit identity (missing sessions, test doubles). */
export function emptySessionUsage(
    provider = 'unknown',
    modelId = 'unknown'
): SessionUsage {
    return {
        provider,
        modelId,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolResults: 0,
        toolCalls: [],
    }
}

/** Numeric delta between two cumulative readings (identity from current). */
export function subtractSessionUsage(
    current: SessionUsage,
    baseline: SessionUsage | undefined
): SessionUsage {
    const base =
        baseline ?? emptySessionUsage(current.provider, current.modelId)
    const names = new Set([
        ...current.toolCalls.map((entry) => entry.name),
        ...base.toolCalls.map((entry) => entry.name),
    ])
    const toolCalls: SessionToolCallCount[] = []
    for (const name of names) {
        const count =
            (current.toolCalls.find((entry) => entry.name === name)?.count ??
                0) -
            (base.toolCalls.find((entry) => entry.name === name)?.count ?? 0)
        if (count > 0) toolCalls.push({ name, count })
    }
    toolCalls.sort((left, right) => left.name.localeCompare(right.name))
    return {
        provider: current.provider,
        modelId: current.modelId,
        input: Math.max(0, current.input - base.input),
        output: Math.max(0, current.output - base.output),
        cacheRead: Math.max(0, current.cacheRead - base.cacheRead),
        cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
        cost: Math.max(0, current.cost - base.cost),
        userMessages: Math.max(0, current.userMessages - base.userMessages),
        assistantMessages: Math.max(
            0,
            current.assistantMessages - base.assistantMessages
        ),
        toolResults: Math.max(0, current.toolResults - base.toolResults),
        toolCalls,
    }
}

/** Take the most recent N logical turns (newline-joined baseline). */
export function selectForkHistory(
    parentHistory: readonly string[],
    fork: ForkTurns
): string[] {
    switch (fork._tag) {
        case 'All':
            return [...parentHistory]
        case 'None':
            return []
        case 'LastN':
            return parentHistory.slice(
                Math.max(0, parentHistory.length - fork.turns)
            )
    }
}
