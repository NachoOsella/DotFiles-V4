import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type {
    ConversationId,
    SettledTask,
    TaskId,
} from '@earendil-works/pi-durable'
import { formatEnvelope } from '../src/domain/communication.js'
import {
    createAgentConversation,
    createFauxGate,
    createReporterScenario,
    createReporterTask,
    createTestHarness,
} from '../src/testing/index.js'
import type { TestHarness } from '../src/testing/index.js'
import type { ReporterResult } from '../src/tasks/reporter-task.js'

function completed<R>(settled: SettledTask<R>): R {
    const outcome = settled.state.outcome
    if (outcome.status !== 'completed') {
        throw new Error(`task ${settled.id} ended ${outcome.status}`)
    }
    return outcome.result
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

test('reporter posts one FINAL_ANSWER and records the parent submission id', async () => {
    const harness = await createTestHarness()
    try {
        harness.faux!.setResponses([
            fauxAssistantMessage('child answer'),
            fauxAssistantMessage('root answer'),
        ])
        const scenario = await createReporterScenario(harness, {
            childPath: '/root/worker',
            parentPath: '/root',
        })
        const result = completed(
            await harness.harness.waitForTask(
                scenario.reporterId,
                harness.context
            )
        )
        assert.equal(result.reported, true)
        assert.ok(result.parentSubmissionId !== undefined)
        assert.ok(result.answerEntryId !== undefined)

        const root = await harness.harness.conversation(
            scenario.rootId,
            harness.context
        )
        await root!.waitForIdle(harness.context)
        const view = await root!.context(harness.context)
        assert.equal(finals(view), 1)
        assert.match(JSON.stringify(view.entries), /child answer/)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('two steers that settle to one answer share one parent report', async () => {
    const harness = await createTestHarness({
        settings: { steeringMode: 'all' },
    })
    try {
        const gate = createFauxGate('first answer')
        harness.faux!.setResponses([
            gate.response,
            fauxAssistantMessage('second answer'),
            fauxAssistantMessage('root one'),
            fauxAssistantMessage('root two'),
        ])
        const scenario = await createReporterScenario(harness, {
            childPath: '/root/worker',
            parentPath: '/root',
        })
        await gate.started

        const content = formatEnvelope(
            'NEW_TASK',
            'worker',
            '/root',
            'steer work'
        )
        // Admit both steers before releasing run one, so they queue into the
        // same run deterministically. The reporters then adopt them.
        const child = await harness.harness.conversation(
            scenario.conversationId,
            harness.context
        )
        await child!.submit(
            {
                type: 'input',
                content,
                whenBusy: 'steer',
                requestId: 'steer-b',
            },
            harness.context
        )
        await child!.submit(
            {
                type: 'input',
                content,
                whenBusy: 'steer',
                requestId: 'steer-c',
            },
            harness.context
        )
        const steer = (requestId: string): Promise<TaskId<ReporterResult>> =>
            createReporterTask(harness, {
                childPath: scenario.path,
                childId: scenario.conversationId,
                parentPath: scenario.parentPath,
                parentId: scenario.rootId,
                content,
                whenBusy: 'steer',
                childRequestId: requestId,
            })
        const steerB = await steer('steer-b')
        const steerC = await steer('steer-c')

        gate.release()
        completed(
            await harness.harness.waitForTask(
                scenario.reporterId,
                harness.context
            )
        )
        const b = completed(
            await harness.harness.waitForTask(steerB, harness.context)
        )
        const c = completed(
            await harness.harness.waitForTask(steerC, harness.context)
        )

        assert.ok(b.answerEntryId !== undefined)
        assert.equal(b.answerEntryId, c.answerEntryId)
        assert.equal(b.parentSubmissionId, c.parentSubmissionId)

        const root = await harness.harness.conversation(
            scenario.rootId,
            harness.context
        )
        await root!.waitForIdle(harness.context)
        const view = await root!.context(harness.context)
        assert.equal(finals(view), 2)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('aborted child work produces no parent report', async () => {
    const harness = await createTestHarness()
    try {
        const gate = createFauxGate('never delivered')
        harness.faux!.setResponses([gate.response])
        const scenario = await createReporterScenario(harness, {
            childPath: '/root/worker',
            parentPath: '/root',
        })
        await gate.started

        const child = await harness.harness.conversation(
            scenario.conversationId,
            harness.context
        )
        await child!.abort(harness.context)

        const result = completed(
            await harness.harness.waitForTask(
                scenario.reporterId,
                harness.context
            )
        )
        assert.equal(result.reported, false)
        assert.equal(result.reason, 'aborted')
        assert.equal(result.parentSubmissionId, undefined)

        const root = await harness.harness.conversation(
            scenario.rootId,
            harness.context
        )
        const view = await root!.context(harness.context)
        assert.equal(finals(view), 0)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('a model error becomes one bounded failure report', async () => {
    const harness = await createTestHarness({
        settings: { retry: { enabled: false } },
    })
    try {
        harness.faux!.setResponses([
            fauxAssistantMessage('', {
                stopReason: 'error',
                errorMessage: 'provider exploded',
            }),
            fauxAssistantMessage('root answer'),
        ])
        const scenario = await createReporterScenario(harness, {
            childPath: '/root/worker',
            parentPath: '/root',
        })
        const result = completed(
            await harness.harness.waitForTask(
                scenario.reporterId,
                harness.context
            )
        )
        assert.equal(result.reported, true)
        assert.equal(result.reason, 'model_error')

        const root = await harness.harness.conversation(
            scenario.rootId,
            harness.context
        )
        await root!.waitForIdle(harness.context)
        const view = await root!.context(harness.context)
        assert.equal(finals(view), 1)
        assert.match(JSON.stringify(view.entries), /provider exploded/)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('a done answer that is not an assistant entry faults the reporter', async () => {
    const harness = await createTestHarness()
    try {
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
        const agent = await createAgentConversation(harness, {
            path: '/root/worker',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        const requestId = 'forged-answer'
        await harness.harness.commit(async (tx) => {
            const entry = await tx.appendEntry(agent.conversationId, {
                kind: 'pi.user',
                model: [
                    {
                        role: 'user',
                        content: 'not an assistant',
                        timestamp: Date.now(),
                    },
                ],
            })
            const submission = await tx.createSubmission({
                conversationId: agent.conversationId,
                type: 'input',
                status: 'placed',
                entry: entry.id,
                requestId,
            })
            tx.settleSubmission(submission.id, {
                status: 'done',
                answer: entry.id,
            })
        }, harness.context)

        const reporterId = await createReporterTask(harness, {
            childPath: agent.path,
            childId: agent.conversationId,
            parentPath: '/root',
            parentId: root.id,
            content: formatEnvelope('NEW_TASK', 'worker', '/root', 'work'),
            whenBusy: 'steer',
            childRequestId: requestId,
        })
        const settled = await harness.harness.waitForTask(
            reporterId,
            harness.context
        )
        assert.equal(settled.state.outcome.status, 'faulted')

        const view = await root.context(harness.context)
        assert.equal(finals(view), 0)
    } finally {
        await harness.harness.close(harness.context)
    }
})

test('an idle nested parent resumes and its answer reaches root once', async () => {
    const harness = await createTestHarness()
    try {
        harness.faux!.setResponses([
            fauxAssistantMessage('child answer'),
            fauxAssistantMessage('parent resumed answer'),
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
        const parent = await createAgentConversation(harness, {
            path: '/root/parent',
            parentPath: '/root',
            parentConversationId: root.id,
        })
        const child = await createAgentConversation(harness, {
            path: '/root/parent/worker',
            parentPath: '/root/parent',
            parentConversationId: parent.conversationId,
        })
        const reporterId = await createReporterTask(harness, {
            childPath: child.path,
            childId: child.conversationId,
            parentPath: parent.path,
            parentId: parent.conversationId,
            content: formatEnvelope('NEW_TASK', 'worker', parent.path, 'work'),
            whenBusy: 'followUp',
        })
        completed(
            await harness.harness.waitForTask(reporterId, harness.context)
        )

        const chained = await reporterTasksIn(harness, root.id)
        assert.equal(chained.length, 1)
        completed(
            await harness.harness.waitForTask(chained[0]!, harness.context)
        )

        await root.waitForIdle(harness.context)
        const view = await root.context(harness.context)
        assert.equal(finals(view), 1)
        assert.match(JSON.stringify(view.entries), /parent resumed answer/)
    } finally {
        await harness.harness.close(harness.context)
    }
})
