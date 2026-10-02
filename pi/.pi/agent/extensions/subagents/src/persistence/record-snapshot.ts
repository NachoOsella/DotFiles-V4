import { ROOT_PATH } from '../domain/agent-path.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import type { AgentId, AgentPath } from '../domain/ids.ts'
import { parsePersistedState } from './session-state.ts'
import type { PersistedSubagentStateV2 } from './schema.ts'

/**
 * Snapshot logical identities only, never live sessions or execution state.
 * @param records Registry records; the root is omitted.
 * @param rootSessionId Root identity for records without an explicit root.
 * @returns A V2 snapshot compatible with native session custom entries.
 * @throws If a child record has an invalid provider/model identity.
 */
export function serializeAgentRecords(
    records: Iterable<AgentRecord>,
    rootSessionId: string
): PersistedSubagentStateV2 {
    return {
        version: 2,
        rootSessionId,
        persistedAt: Date.now(),
        agents: [...records]
            .filter((record) => record.path !== ROOT_PATH)
            .map((record) => ({
                id: record.id,
                path: record.path,
                parentPath: record.parentPath,
                rootSessionId: record.rootSessionId ?? rootSessionId,
                sessionId: record.sessionId,
                sessionFile: record.sessionFile,
                cwd: record.cwd,
                role: record.role,
                model: parseModel(record.model),
                thinkingLevel: record.thinkingLevel,
                activeTools: record.activeTools ?? [],
                status: record.status._tag,
                statusMessage: terminalMessage(record.status),
                createdAt: record.createdAt,
                lastActivityAt: record.lastActivityAt,
                runSequence: record.runSequence ?? 0,
                lastDeliveredRunSequence: record.lastDeliveredRunSequence,
                pendingCompletions: record.pendingCompletions,
                lastResult: record.lastResult,
                task: record.task,
                usage: record.usage,
            })),
    }
}

/**
 * Normalize saved data into unloaded, non-running records.
 * @param value A saved V2 snapshot, possibly malformed.
 * @param rootSessionId Active root, or 'unknown-root' before root discovery.
 * @returns Recovered identities, or an empty array for unusable/foreign data.
 */
export function restoreAgentRecords(
    value: unknown,
    rootSessionId: string
): AgentRecord[] {
    const state = parsePersistedState(value)
    if (
        !state ||
        (rootSessionId !== 'unknown-root' &&
            state.rootSessionId !== rootSessionId)
    ) {
        return []
    }
    return state.agents.map((persisted) => ({
        id: persisted.id as AgentId,
        path: persisted.path as AgentPath,
        parentId: null,
        parentPath: persisted.parentPath as AgentPath | null,
        rootSessionId: persisted.rootSessionId,
        sessionId: persisted.sessionId,
        sessionFile: persisted.sessionFile,
        cwd: persisted.cwd,
        role: persisted.role,
        model: `${persisted.model.provider}/${persisted.model.id}`,
        thinkingLevel: persisted.thinkingLevel,
        activeTools: persisted.activeTools,
        status: restoredStatus(persisted.status, persisted.statusMessage),
        residency: 'unloaded',
        createdAt: persisted.createdAt,
        lastActivityAt: persisted.lastActivityAt,
        runSequence: persisted.runSequence,
        lastDeliveredRunSequence: persisted.lastDeliveredRunSequence,
        pendingCompletions: persisted.pendingCompletions,
        lastResult: persisted.lastResult,
        task: persisted.task,
        usage: persisted.usage,
    }))
}

function terminalMessage(status: AgentStatus): string | undefined {
    if (status._tag === 'Completed') return status.message ?? undefined
    if (status._tag === 'Errored') return status.error
    return undefined
}

function restoredStatus(tag: string, message?: string): AgentStatus {
    switch (tag) {
        case 'Completed':
            return AgentStatus.completed(message ?? null)
        case 'Errored':
            return AgentStatus.errored(message ?? 'unknown error')
        case 'Interrupted':
        case 'Running':
            return AgentStatus.interrupted()
        case 'Shutdown':
            return AgentStatus.shutdown()
        case 'NotFound':
            return AgentStatus.notFound()
        default:
            return AgentStatus.pendingInit()
    }
}

function parseModel(value: string): { provider: string; id: string } {
    const separator = value.indexOf('/')
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid model identity "${value}".`)
    }
    return {
        provider: value.slice(0, separator),
        id: value.slice(separator + 1),
    }
}
