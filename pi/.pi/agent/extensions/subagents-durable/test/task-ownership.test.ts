import assert from 'node:assert/strict'
import test from 'node:test'
import { formatEnvelope } from '../src/domain/communication.js'
import {
    createAgentConversation,
    createFauxGate,
    createReporterTask,
    createTestHarness,
} from '../src/testing/index.js'

test('background anchors keep child work out of parent idle and ordinary abort', async () => {
    const harness = await createTestHarness()
    try {
        const gate = createFauxGate('child answer')
        harness.faux!.setResponses([gate.response])
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
        await gate.started

        // Child work is live, but the background anchor keeps root idle.
        await root.waitForIdle(harness.context)

        // Ordinary abort does not reach the background child or its reporter.
        await root.abort(harness.context)
        const childConversation = await harness.harness.conversation(
            child.conversationId,
            harness.context
        )
        const ordinary = await childConversation!.context(harness.context)
        assert.ok(ordinary.entries.length > 0)

        // A full background abort crosses the anchor and reaches both.
        await root.abort(harness.context, { background: true })
        const reporter = await harness.harness.waitForTask(
            reporterId,
            harness.context
        )
        assert.equal(reporter.state.outcome.status, 'aborted')
    } finally {
        await harness.harness.close(harness.context)
    }
})
