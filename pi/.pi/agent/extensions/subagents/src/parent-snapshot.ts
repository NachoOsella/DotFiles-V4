import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import type {
    AgentSession,
    SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type { AgentPath } from './ids.ts'

export interface ModelIdentity {
    readonly provider: string
    readonly id: string
}

export interface ParentExecutionSnapshot {
    readonly path: AgentPath
    readonly cwd: string
    readonly model: ModelIdentity
    readonly thinkingLevel: ThinkingLevel
    readonly activeTools: readonly string[]
    readonly contextEntries: readonly SessionEntry[]
    readonly sessionFile?: string
    readonly sessionId: string
}

export function snapshotFromChild(
    path: AgentPath,
    session: AgentSession
): ParentExecutionSnapshot {
    const model = session.model
    if (!model) throw new Error(`Agent ${path} has no selected model.`)
    return {
        path,
        cwd: session.sessionManager.getCwd(),
        model: { provider: model.provider, id: model.id },
        thinkingLevel: session.thinkingLevel,
        activeTools: session.getActiveToolNames(),
        contextEntries: session.sessionManager.buildContextEntries(),
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
    }
}

export interface ResolvedModel {
    readonly model: Model<any>
    readonly identity: ModelIdentity
}
