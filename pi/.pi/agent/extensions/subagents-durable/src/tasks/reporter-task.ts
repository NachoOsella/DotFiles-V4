/**
 * Background reporter task.
 *
 * One reporter delivers one work submission (spawn or followup) to a child
 * conversation and posts a bounded FINAL_ANSWER envelope back to the direct
 * parent when that work reaches a terminal answer.
 *
 * Exactly-once delivery rests on Durable request IDs, not on an outbox. Child
 * input uses `reporter:<reporterTaskId>`, unless the reporter adopts an existing
 * submission through `childRequestId` (chaining below). A successful report
 * uses `subagents.report:<childId>:<answerEntryId>`, so several steers that
 * settle to one answer produce one parent report even from separate reporters.
 * A failure report uses `subagents.report:<childId>:submission:<childSubmissionId>`.
 *
 * The `submit` phase waits for settlement and then commits the whole report
 * decision (payload and stable request ID) as one checkpoint, so a crash on
 * either side of the parent submission is safe. Aborted work reports nothing.
 *
 * Chaining: reporting to a registered non-root parent wakes it, and its answer
 * must reach the parent's parent. The reporter's terminal commit creates a
 * chained reporter in the grandparent conversation, which adopts the parent
 * report submission and repeats one level up until `/root` ends the chain.
 */

import type { Context } from '@earendil-works/chord'
import type { Message } from '@earendil-works/pi-ai'
import {
    AssistantEntry,
    ROOT_CONVERSATION_ID,
    defineTask,
} from '@earendil-works/pi-durable'
import type {
    ConversationId,
    EntryId,
    NextTaskState,
    SettledSubmissionRecord,
    SubmissionId,
    TaskId,
    Tx,
} from '@earendil-works/pi-durable'
import { ROOT_PATH } from '../domain/agent-path.js'
import { displayNameFor, formatEnvelope } from '../domain/communication.js'
import { SubagentsDoc } from '../state/subagents-doc.js'

/** One work submission to deliver and report on. */
export type ReporterInput = {
    readonly childPath: string
    readonly childId: ConversationId
    readonly parentPath: string
    readonly parentId: ConversationId
    /** Already-rendered NEW_TASK envelope delivered to the child. */
    readonly content: string
    readonly whenBusy: 'steer' | 'followUp'
    /**
     * Adopt an existing child submission instead of the reporter's own request
     * ID. A chained reporter uses the parent report request ID so it waits on
     * the run its parent report already started.
     */
    readonly childRequestId?: string
}

/** One report decision: the envelope payload and its stable request ID. */
type ReporterReport = {
    readonly requestId: string
    readonly payload: string
    readonly answerEntryId?: EntryId
}

export type ReporterCheckpoint =
    | { readonly phase: 'submit' }
    | {
          readonly phase: 'report'
          readonly childSubmissionId: SubmissionId
          /** Settlement reason, carried into the terminal receipt. */
          readonly reason?: string
          /** Absent when the child work was aborted and must not be reported. */
          readonly report?: ReporterReport
      }

export type ReporterResult = {
    readonly childSubmissionId: SubmissionId
    readonly answerEntryId?: EntryId
    readonly parentSubmissionId?: SubmissionId
    readonly reported: boolean
    readonly reason?: string
}

type ReportCheckpoint = Extract<ReporterCheckpoint, { phase: 'report' }>
type ReporterNext = NextTaskState<ReporterCheckpoint, ReporterResult>

const MAX_FAILURE_CHARS = 3200

/** Child input request ID: one per reporter task, stable across replay. */
export function childRequestId(reporterId: TaskId): string {
    return `reporter:${reporterId}`
}

/** Parent report request ID for a successful answer. */
export function reportRequestId(
    childId: ConversationId,
    answerEntryId: EntryId
): string {
    return `subagents.report:${childId}:${answerEntryId}`
}

/** Parent report request ID for a bounded failure report. */
export function failureRequestId(
    childId: ConversationId,
    childSubmissionId: SubmissionId
): string {
    return `subagents.report:${childId}:submission:${childSubmissionId}`
}

export const ReporterTask = defineTask<
    ReporterInput,
    ReporterCheckpoint,
    ReporterResult
>({
    name: 'subagents.reporter',
    version: 1,
    initial: () => ({ phase: 'submit' }),
    phases: {
        submit: async (task, runtime, context) => {
            const input = task.input
            const child = await runtime.conversation(input.childId, context)
            if (child === undefined) {
                throw new Error(
                    `Reporter ${runtime.taskId} child conversation ${input.childId} is missing`
                )
            }
            const submission = await child.submit(
                {
                    type: 'input',
                    content: input.content,
                    whenBusy: input.whenBusy,
                    requestId:
                        input.childRequestId ?? childRequestId(runtime.taskId),
                },
                context
            )
            const settled = await submission.wait(context)
            await runtime.commit(
                async (tx) => ({
                    status: 'running',
                    checkpoint: await deriveReport(
                        tx,
                        input,
                        runtime.taskId,
                        submission.id,
                        settled
                    ),
                }),
                context
            )
        },

        report: async (task, runtime, context) => {
            const checkpoint = task.state.checkpoint
            const report = checkpoint.report
            if (report === undefined) {
                await runtime.commit(() => terminalReceipt(checkpoint), context)
                return
            }
            const content = finalAnswerEnvelope(task.input, report.payload)
            const parent = await runtime.conversation(
                task.input.parentId,
                context
            )
            if (parent === undefined) {
                throw new Error(
                    `Reporter ${runtime.taskId} parent conversation ${task.input.parentId} is missing`
                )
            }
            const submission = await parent.submit(
                {
                    type: 'input',
                    content,
                    whenBusy: 'steer',
                    requestId: report.requestId,
                },
                context
            )
            await runtime.commit(async (tx) => {
                await chainReport(tx, task.input, content, report.requestId)
                return terminalReceipt(checkpoint, submission.id)
            }, context)
        },
    },
    abort: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint
        const childSubmissionId =
            checkpoint.phase === 'report'
                ? checkpoint.childSubmissionId
                : undefined
        await runtime.commit(
            () => ({
                status: 'terminal',
                outcome: {
                    status: 'aborted',
                    reason: 'reporter aborted',
                    ...(childSubmissionId === undefined
                        ? {}
                        : {
                              result: {
                                  childSubmissionId,
                                  reported: false,
                                  reason: 'aborted',
                              },
                          }),
                },
            }),
            context
        )
    },
})

/**
 * Read the committed answer and decide the whole report in one table read. A
 * done submission that does not name an assistant entry is a durable-state
 * fault, not an empty success.
 */
async function deriveReport(
    tx: Tx,
    input: ReporterInput,
    reporterId: TaskId,
    childSubmissionId: SubmissionId,
    settled: SettledSubmissionRecord
): Promise<ReportCheckpoint> {
    if (settled.type !== 'input') {
        throw new Error(`Reporter ${reporterId} settled a non-input submission`)
    }
    if (settled.status === 'done') {
        const message = (await tx.entry(AssistantEntry, settled.answer))
            ?.model?.[0]
        if (message === undefined || message.role !== 'assistant') {
            throw new Error(
                `Reporter ${reporterId} answer entry ${settled.answer} is not an assistant entry`
            )
        }
        return {
            phase: 'report',
            childSubmissionId,
            report: {
                requestId: reportRequestId(input.childId, settled.answer),
                payload: assistantText(message),
                answerEntryId: settled.answer,
            },
        }
    }
    if (settled.reason === 'aborted') {
        return { phase: 'report', childSubmissionId, reason: 'aborted' }
    }
    return {
        phase: 'report',
        childSubmissionId,
        reason: settled.reason,
        report: {
            requestId: failureRequestId(input.childId, childSubmissionId),
            payload: boundedFailure(
                settled.reason,
                typeof settled.detail === 'string' ? settled.detail : undefined
            ),
        },
    }
}

function terminalReceipt(
    checkpoint: ReportCheckpoint,
    parentSubmissionId?: SubmissionId
): ReporterNext {
    const report = checkpoint.report
    return {
        status: 'terminal',
        outcome: {
            status: 'completed',
            result: {
                childSubmissionId: checkpoint.childSubmissionId,
                reported: report !== undefined,
                ...(report?.answerEntryId === undefined
                    ? {}
                    : { answerEntryId: report.answerEntryId }),
                ...(parentSubmissionId === undefined
                    ? {}
                    : { parentSubmissionId }),
                ...(checkpoint.reason === undefined
                    ? {}
                    : { reason: checkpoint.reason }),
            },
        },
    }
}

/**
 * Create the next reporter in the grandparent conversation when the report
 * target is a registered non-root agent. The chained reporter adopts the parent
 * report submission and reports the parent's answer one level up.
 */
async function chainReport(
    tx: Tx,
    input: ReporterInput,
    content: string,
    requestId: string
): Promise<void> {
    if (input.parentPath === ROOT_PATH) return
    const state = await tx.doc(SubagentsDoc)
    const parent = state.agents[input.parentPath]
    if (parent === undefined) {
        throw new Error(
            `Reporter parent ${input.parentPath} is not registered; the report cannot chain upward`
        )
    }
    const grandparentPath = parent.parentPath
    const grandparentId =
        grandparentPath === ROOT_PATH
            ? ROOT_CONVERSATION_ID
            : state.agents[grandparentPath]?.conversationId
    if (grandparentId === undefined) {
        throw new Error(
            `Reporter grandparent ${grandparentPath} is not registered; the report cannot chain upward`
        )
    }
    await tx.createTask(
        ReporterTask,
        {
            childPath: input.parentPath,
            childId: input.parentId,
            parentPath: grandparentPath,
            parentId: grandparentId,
            content,
            whenBusy: 'steer',
            childRequestId: requestId,
        },
        {
            ownership: { kind: 'conversation' },
            conversationId: grandparentId,
            background: true,
        }
    )
}

function finalAnswerEnvelope(input: ReporterInput, payload: string): string {
    return formatEnvelope(
        'FINAL_ANSWER',
        displayNameFor(input.parentPath),
        input.childPath,
        payload
    )
}

function assistantText(
    message: Extract<Message, { role: 'assistant' }>
): string {
    return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
}

/** Bound a terminal error so one failure cannot flood the parent transcript. */
function boundedFailure(reason: string, detail: string | undefined): string {
    const raw = (detail ?? reason).trim()
    const text =
        raw.length > MAX_FAILURE_CHARS
            ? `${raw.slice(0, MAX_FAILURE_CHARS)}…`
            : raw
    return `Agent did not answer: ${text}\nYou may retry with followup_task using a narrower task.`
}
