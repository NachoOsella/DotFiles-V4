/**
 * Adversarial reporter races.
 *
 * Deterministic gates only: a scripted faux response router decides by the
 * conversation's own transcript, and storage/faux gates pause exact durable
 * points. No sleeps and no timing loops.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type {
    FauxResponseFactory,
    TranscriptContext,
} from '@earendil-works/pi-ai'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import { formatEnvelope } from '../src/domain/communication.js'
import {
    createAgentConversation,
    createFauxGate,
    createReporterTask,
    createTestHarness,
} from '../src/testing/index.js'
import type { TestHarness } from '../src/testing/index.js'
import type { ReporterResult } from '../src/tasks/reporter-task.js'
import type { SettledTask } from '@earendil-works/pi-durable'

function completed<R>(settled: SettledTask<R>): R {
    const outcome = settled.state.outcome
    if (outcome.status !== 'completed') {
        throw new Error(`task ${settled.id} ended ${outcome.status}`)
    }
    return outcome.result
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .map((part) =>
            part && typeof part === 'object' && 'text' in part
                ? String((part as { text?: unknown }).text ?? '')
                : ''
        )
        .join('')
}

function userText(context: TranscriptContext): string {
    return context.messages
        .filter((message) => message.role === 'user')
        .map((message) => textOf(message.content))
        .join('\n')
}

function finals(view: {
    entries: readonly { model?: readonly unknown[] }[]
}): number {
    return view.entries.filter((entry) =>
        JSON.stringify(entry.model ?? []).includes('FINAL_ANSWER')
    ).length
}

async function reporterTasksIn(
    harness: TestHarness,
    conversationId: ConversationId
): Promise<TaskId<ReporterResult>[]> {
    const page = await harness.harness.commit(
        (tx) =>
            tx.scanTasks({ conversationId, kind: 'subagents.reporter' }, 50),
        harness.context
    )
    return page.items.map((record) => record.id as TaskId<ReporterResult>)
}

/**
 * Two children answer while their shared parent is mid-run. Both reports must
 * land once each, and the duplicate-observer failure mode would add a parent or
 * root model request, so the exact request count is asserted.
 */
test(
    'two children reporting to a busy parent deliver one report each',
    { timeout: 15_000 },
    async () => {
        const harness = await createTestHarness({
            settings: { steeringMode: 'all' },
        })
        try {
            const parentGate = createFauxGate('parent answer')
            const router: FauxResponseFactory = (
                context,
                options,
                state,
                model
            ) => {
                harness.faux!.appendResponses([router])
                const text = userText(context)
                if (text.includes('Task name: worker_a')) {
                    return fauxAssistantMessage('answer a')
                }
                if (text.includes('Task name: worker_b')) {
                    return fauxAssistantMessage('answer b')
                }
                if (text.includes('parent task')) {
                    return parentGate.response(context, options, state, model)
                }
                return fauxAssistantMessage('root answer')
            }
            harness.faux!.setResponses([router])

            const root = await harness.harness.root(harness.context)
            await root.configure(
                {
                    model: {
                        provider: harness.provider,
                        modelId: harness.modelId,
                    },
                },
                harness.context
            )
            const parent = await createAgentConversation(harness, {
                path: '/root/parent',
                parentPath: '/root',
                parentConversationId: root.id,
            })
            const workerA = await createAgentConversation(harness, {
                path: '/root/parent/worker_a',
                parentPath: '/root/parent',
                parentConversationId: parent.conversationId,
            })
            const workerB = await createAgentConversation(harness, {
                path: '/root/parent/worker_b',
                parentPath: '/root/parent',
                parentConversationId: parent.conversationId,
            })

            // Parent is mid-run before either child reports.
            const parentConversation = await harness.harness.conversation(
                parent.conversationId,
                harness.context
            )
            await parentConversation!.submit(
                { type: 'input', content: 'parent task' },
                harness.context
            )
            await parentGate.started

            const reporterA = await createReporterTask(harness, {
                childPath: workerA.path,
                childId: workerA.conversationId,
                parentPath: parent.path,
                parentId: parent.conversationId,
                content: formatEnvelope(
                    'NEW_TASK',
                    'worker_a',
                    parent.path,
                    'work a'
                ),
                whenBusy: 'followUp',
            })
            const reporterB = await createReporterTask(harness, {
                childPath: workerB.path,
                childId: workerB.conversationId,
                parentPath: parent.path,
                parentId: parent.conversationId,
                content: formatEnvelope(
                    'NEW_TASK',
                    'worker_b',
                    parent.path,
                    'work b'
                ),
                whenBusy: 'followUp',
            })

            const a = completed(
                await harness.harness.waitForTask(reporterA, harness.context)
            )
            const b = completed(
                await harness.harness.waitForTask(reporterB, harness.context)
            )
            assert.equal(a.reported, true)
            assert.equal(b.reported, true)
            assert.notEqual(a.parentSubmissionId, b.parentSubmissionId)

            parentGate.release()

            const chained = await reporterTasksIn(harness, root.id)
            assert.equal(chained.length, 2)
            for (const id of chained) {
                completed(
                    await harness.harness.waitForTask(id, harness.context)
                )
            }
            await root.waitForIdle(harness.context)

            const parentView = await parentConversation!.context(
                harness.context
            )
            assert.equal(finals(parentView), 2)

            const rootView = await root.context(harness.context)
            assert.equal(finals(rootView), 1)

            // worker a + worker b + parent first + parent steer run + root = 5.
            assert.equal(harness.faux!.state.callCount, 5)

            // Each child input was admitted once.
            for (const worker of [workerA, workerB]) {
                const submissions = await harness.storage.scanSubmissions(
                    { conversationId: worker.conversationId },
                    50,
                    undefined,
                    harness.context
                )
                assert.equal(
                    submissions.items.filter((record) =>
                        record.requestId?.startsWith('reporter:')
                    ).length,
                    1
                )
            }
        } finally {
            await harness.harness.close(harness.context)
        }
    }
)

/**
 * The child answer is committed (submission done) before the interrupt. The
 * interrupt therefore cannot suppress the report; it must still arrive once.
 */
test(
    'interrupt after the answer commit still delivers one report',
    { timeout: 15_000 },
    async () => {
        const harness = await createTestHarness()
        try {
            harness.faux!.setResponses([
                fauxAssistantMessage('child answer'),
                fauxAssistantMessage('root answer'),
            ])
            const root = await harness.harness.root(harness.context)
            await root.configure(
                {
                    model: {
                        provider: harness.provider,
                        modelId: harness.modelId,
                    },
                },
                harness.context
            )
            const child = await createAgentConversation(harness, {
                path: '/root/worker',
                parentPath: '/root',
                parentConversationId: root.id,
            })
            const reporterId = await createReporterTask(harness, {
                childPath: child.path,
                childId: child.conversationId,
                parentPath: '/root',
                parentId: root.id,
                content: formatEnvelope('NEW_TASK', 'worker', '/root', 'work'),
                whenBusy: 'followUp',
            })

            // Wait for the child generation to be terminal: its answer entry is
            // committed and the input submission is already done.
            const watch = await harness.harness.watchDoc(
                LiveDoc,
                child.conversationId,
                harness.context
            )
            assert.ok(watch)
            const generationId = await new Promise<TaskId>((resolve) => {
                const check = (value: { run?: { taskId: TaskId } } | null) => {
                    if (value?.run !== undefined) {
                        watch.stop()
                        resolve(value.run.taskId)
                    }
                }
                check(watch.value)
                watch.start(async (value) => {
                    check(value)
                })
            })
            await harness.harness.waitForTask(generationId, harness.context)

            const childConversation = await harness.harness.conversation(
                child.conversationId,
                harness.context
            )
            await childConversation!.abort(harness.context)

            const result = completed(
                await harness.harness.waitForTask(reporterId, harness.context)
            )
            assert.equal(result.reported, true)
            assert.ok(result.answerEntryId !== undefined)

            await root.waitForIdle(harness.context)
            const view = await root.context(harness.context)
            assert.equal(finals(view), 1)
        } finally {
            await harness.harness.close(harness.context)
        }
    }
)
