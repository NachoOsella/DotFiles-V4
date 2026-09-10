/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/protocol/src/items.rs (CollabAgentToolCallItem, SubAgentActivityItem)
 *
 * Three planes: domain/runtime events, model-visible messages (elsewhere),
 * and UI-only activity. Never feed ToolActivity back into the parent model.
 */

import type {
    AgentId,
    AgentPath,
    CommunicationId,
    ToolCallId,
    TurnId,
} from './ids.ts'
import type { AgentResidency, AgentStatus } from './agent-status.ts'
import type { InterAgentCommunication } from './communication.ts'

export type SubagentEvent =
    | {
          readonly _tag: 'ActivityStarted'
          readonly callId: ToolCallId
          readonly agentId: AgentId
          readonly agentPath: AgentPath
          readonly parentTurnId: TurnId
      }
    | {
          readonly _tag: 'ActivityInteracted'
          readonly callId: ToolCallId
          readonly agentId: AgentId
          readonly agentPath: AgentPath
      }
    | {
          readonly _tag: 'ActivityInterrupted'
          readonly callId: ToolCallId
          readonly agentId: AgentId
          readonly agentPath: AgentPath
      }
    | {
          readonly _tag: 'ActivityCompleted'
          readonly agentId: AgentId
          readonly agentPath: AgentPath
          readonly parentTurnId: TurnId
      }
    | {
          readonly _tag: 'StatusChanged'
          readonly agentId: AgentId
          readonly previous: AgentStatus
          readonly current: AgentStatus
      }
    | {
          readonly _tag: 'CommunicationEnqueued'
          readonly communication: InterAgentCommunication
      }
    | {
          readonly _tag: 'CommunicationDelivered'
          readonly communicationId: CommunicationId
      }
    | {
          readonly _tag: 'ResidencyChanged'
          readonly agentId: AgentId
          readonly residency: AgentResidency
      }
    | {
          readonly _tag: 'ToolActivity'
          readonly agentId: AgentId
          readonly summary: string
      }
