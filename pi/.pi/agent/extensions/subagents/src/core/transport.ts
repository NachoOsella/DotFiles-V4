import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InterAgentCommunication } from '../domain/communication.ts'
import { renderCommunicationText } from '../domain/communication.ts'
import type { AgentPath } from '../domain/ids.ts'

export const SUBAGENTS_COMMUNICATION_CUSTOM_TYPE = 'subagents-v3:communication'

export interface DeliveryOptions {
    readonly triggerTurn: boolean
    readonly delivery?: 'steer' | 'followUp' | 'nextTurn'
}

export type InsertionState = 'absent' | 'accepted' | 'unknown'

/** Reads a recipient transcript and reports whether an envelope was inserted. */
export type InsertionProbe = (
    communicationId: string
) => InsertionState | Promise<InsertionState>

export interface CommunicationEndpoint {
    readonly path: AgentPath
    /** Dispatch only. Completion of this promise is not an insertion receipt. */
    send(
        communication: InterAgentCommunication,
        options: DeliveryOptions
    ): Promise<void>
    /** Optional durable transcript receipt. Absent means legacy best effort. */
    probeInsertion?(
        communicationId: string
    ): InsertionState | Promise<InsertionState>
}

/**
 * Probe a native session's current branch for a communication envelope. Root
 * and child sessions persist custom messages with `details.id`, so the same
 * insertion check applies to both. A probe failure is ambiguous, never absent.
 */
export function sessionInsertionProbe(session: AgentSession): InsertionProbe {
    return (communicationId) => {
        try {
            const branch = session.sessionManager.getBranch()
            return branch.some((entry) => {
                if (entry.type !== 'custom_message') return false
                const details = (entry as { details?: { id?: unknown } })
                    .details
                return details?.id === communicationId
            })
                ? 'accepted'
                : 'absent'
        } catch {
            return 'unknown'
        }
    }
}

function customMessage(comm: InterAgentCommunication) {
    return {
        customType: SUBAGENTS_COMMUNICATION_CUSTOM_TYPE,
        content: renderCommunicationText(comm),
        display: false,
        details: {
            id: comm.id,
            kind: comm.kind,
            messageType: comm.messageType,
            author: comm.author,
            recipient: comm.recipient,
            payload: comm.payload,
            sourceCallId: comm.sourceCallId,
            initiatingTurnId: comm.initiatingTurnId,
            meta: comm.meta,
        },
    }
}

export function childEndpoint(
    path: AgentPath,
    session: AgentSession,
    probeInsertion?: InsertionProbe
): CommunicationEndpoint {
    return {
        path,
        async send(comm, options) {
            await session.sendCustomMessage(customMessage(comm), {
                triggerTurn: options.triggerTurn,
                deliverAs: options.delivery,
            })
        },
        ...(probeInsertion ? { probeInsertion } : {}),
    }
}

export function rootEndpoint(
    path: AgentPath,
    sendMessage: (
        message: ReturnType<typeof customMessage>,
        options: {
            triggerTurn: boolean
            deliverAs?: DeliveryOptions['delivery']
        }
    ) => void | Promise<void>,
    probeInsertion?: InsertionProbe
): CommunicationEndpoint {
    return {
        path,
        async send(comm, options) {
            const message = customMessage(comm)
            await sendMessage(
                {
                    ...message,
                    // Root completions stay visible in the transcript. Delivery
                    // itself steers (see coordinator.deliverCompletion) so the
                    // running parent actually ingests them mid-run.
                    display: comm.messageType === 'FINAL_ANSWER',
                },
                {
                    triggerTurn: options.triggerTurn,
                    deliverAs: options.delivery,
                }
            )
        },
        ...(probeInsertion ? { probeInsertion } : {}),
    }
}
