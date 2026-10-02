import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InterAgentCommunication } from '../domain/communication.ts'
import { renderCommunicationText } from '../domain/communication.ts'
import type { AgentPath } from '../domain/ids.ts'

export const SUBAGENTS_COMMUNICATION_CUSTOM_TYPE = 'subagents-v3:communication'

export interface DeliveryOptions {
    readonly triggerTurn: boolean
    readonly delivery?: 'steer' | 'followUp' | 'nextTurn'
}

export interface CommunicationEndpoint {
    readonly path: AgentPath
    send(
        communication: InterAgentCommunication,
        options: DeliveryOptions
    ): Promise<void>
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
    session: AgentSession
): CommunicationEndpoint {
    return {
        path,
        async send(comm, options) {
            await session.sendCustomMessage(customMessage(comm), {
                triggerTurn: options.triggerTurn,
                deliverAs: options.delivery,
            })
        },
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
    ) => void | Promise<void>
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
    }
}
