import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    VERSION,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import subagentsExtension from '../../index.ts'
import { isSupportedHostVersion } from '../config/host-compatibility.ts'
import { SubagentCoordinator } from '../core/coordinator.ts'
import {
    findLatestState,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from './session-state.ts'
import type { PersistedSubagentStateV2 } from './schema.ts'

const nativeTest = isSupportedHostVersion(VERSION) ? test : test.skip

async function fixture(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-entry-lifecycle-'))
    const agentDir = join(directory, 'agent')
    const manager = SessionManager.create(
        directory,
        join(directory, 'sessions')
    )
    const emptyLeaf = manager.appendMessage({
        role: 'user',
        content: 'Before any delegation.',
        timestamp: Date.now(),
    })
    const snapshot: PersistedSubagentStateV2 = {
        version: 2,
        rootSessionId: manager.getSessionId(),
        persistedAt: Date.now(),
        agents: [
            {
                id: 'reviewer-id',
                path: '/root/reviewer',
                parentPath: '/root',
                rootSessionId: manager.getSessionId(),
                model: { provider: 'test-provider', id: 'test-model' },
                activeTools: [],
                status: 'Completed',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                runSequence: 1,
                lastDeliveredRunSequence: 1,
            },
        ],
    }
    const teamLeaf = manager.appendCustomEntry(
        SUBAGENTS_STATE_CUSTOM_TYPE,
        snapshot
    )
    const settingsManager = SettingsManager.create(directory, agentDir)
    let api: ExtensionAPI | undefined
    const resourceLoader = new DefaultResourceLoader({
        cwd: directory,
        agentDir,
        settingsManager,
        noExtensions: true,
        noThemes: true,
        extensionFactories: [
            (pi) => {
                api = pi
                subagentsExtension(pi)
            },
        ],
    })
    await resourceLoader.reload()
    assert.deepEqual(resourceLoader.getExtensions().errors, [])
    const { session } = await createAgentSession({
        cwd: directory,
        agentDir,
        settingsManager,
        resourceLoader,
        sessionManager: manager,
        tools: ['list_agents'],
    })
    const errors: string[] = []
    await session.bindExtensions({
        onError: (error) => errors.push(error.error),
    })
    t.after(async () => {
        try {
            await session.extensionRunner.emit({
                type: 'session_shutdown',
                reason: 'quit',
            })
        } finally {
            session.dispose()
            rmSync(directory, { recursive: true, force: true })
        }
        assert.deepEqual(errors, [])
    })

    async function listed(): Promise<string[]> {
        const tool = session.agent.state.tools.find(
            (item) => item.name === 'list_agents'
        )
        assert.ok(tool)
        const result = await tool.execute('entry-list', {})
        const details = result.details as {
            agents: Array<{ agent_name: string }>
        }
        return details.agents.map((agent) => agent.agent_name)
    }
    assert.ok(api)
    return { manager, session, snapshot, emptyLeaf, teamLeaf, listed, api }
}

nativeTest(
    'tree navigation replaces membership without keeping stale root tool handlers',
    async (t) => {
        const { session, manager, emptyLeaf, teamLeaf, listed } =
            await fixture(t)
        assert.deepEqual(await listed(), ['/root/reviewer'])

        await session.navigateTree(emptyLeaf)
        assert.deepEqual(await listed(), [])
        assert.equal(findLatestState(manager.getBranch()), undefined)

        await session.navigateTree(teamLeaf)
        assert.deepEqual(await listed(), ['/root/reviewer'])
    }
)

nativeTest(
    'the closing checkpoint includes mutations completed during shutdown',
    async (t) => {
        const { session, manager, snapshot } = await fixture(t)
        const original = SubagentCoordinator.prototype.shutdown
        SubagentCoordinator.prototype.shutdown = async function () {
            await original.call(this)
            this.restore({
                ...snapshot,
                agents: [
                    {
                        ...snapshot.agents[0]!,
                        id: 'late-result-id',
                        path: '/root/late_result',
                        statusMessage: 'Final state produced by settlement.',
                    },
                ],
            })
        }
        t.after(() => {
            SubagentCoordinator.prototype.shutdown = original
        })

        await session.extensionRunner.emit({
            type: 'session_shutdown',
            reason: 'quit',
        })
        assert.deepEqual(
            findLatestState(manager.getBranch())?.agents.map(
                (agent) => agent.path
            ),
            ['/root/reviewer', '/root/late_result']
        )
    }
)

nativeTest(
    'unchanged native settlement does not append another identical graph snapshot',
    async (t) => {
        const { session, manager } = await fixture(t)
        await session.extensionRunner.emit({
            type: 'agent_settled',
            outcome: 'completed',
        })
        const first = manager
            .getEntries()
            .filter(
                (entry) =>
                    entry.type === 'custom' &&
                    entry.customType === SUBAGENTS_STATE_CUSTOM_TYPE
            ).length
        await session.extensionRunner.emit({
            type: 'agent_settled',
            outcome: 'completed',
        })
        const second = manager
            .getEntries()
            .filter(
                (entry) =>
                    entry.type === 'custom' &&
                    entry.customType === SUBAGENTS_STATE_CUSTOM_TYPE
            ).length
        assert.equal(second, first)
    }
)

nativeTest(
    'a failed final checkpoint retains the fenced team for a navigation retry',
    async (t) => {
        const { session, manager, snapshot, emptyLeaf, listed, api } =
            await fixture(t)
        const diagnostics = t.mock.method(console, 'error', () => {})
        const originalShutdown = SubagentCoordinator.prototype.shutdown
        let lateQueued = false
        SubagentCoordinator.prototype.shutdown = async function () {
            await originalShutdown.call(this)
            if (lateQueued) return
            lateQueued = true
            this.restore({
                ...snapshot,
                agents: [
                    {
                        ...snapshot.agents[0]!,
                        id: 'late-result-id',
                        path: '/root/late_result',
                        runSequence: 2,
                        lastDeliveredRunSequence: undefined,
                        pendingCompletions: [
                            {
                                communicationId: 'late-completion-id',
                                runSequence: 2,
                                author: '/root/late_result',
                                recipient: '/root',
                                payload: 'Result produced during shutdown.',
                            },
                        ],
                    },
                ],
            })
        }
        t.after(() => {
            SubagentCoordinator.prototype.shutdown = originalShutdown
        })
        const originalAppend = api.appendEntry.bind(api)
        let failCheckpoint = true
        let preCheckpointFailed = false
        let recoveredLeaf: string | null = null
        api.appendEntry = (type, data) => {
            const state = data as PersistedSubagentStateV2 | undefined
            const closing =
                type === SUBAGENTS_STATE_CUSTOM_TYPE &&
                state?.agents.some(
                    (agent) => agent.path === '/root/late_result'
                )
            if (type === SUBAGENTS_STATE_CUSTOM_TYPE && failCheckpoint) {
                if (!closing) preCheckpointFailed = true
                throw new Error('simulated final checkpoint failure')
            }
            originalAppend(type, data)
            if (closing) recoveredLeaf = manager.getLeafId()
        }

        const first = await session.navigateTree(emptyLeaf)
        assert.equal(first.cancelled, true)
        assert.equal(preCheckpointFailed, true)
        assert.equal(lateQueued, true)
        assert.deepEqual(
            findLatestState(manager.getBranch())?.agents.map(
                (agent) => agent.path
            ),
            ['/root/reviewer']
        )
        assert.ok(
            diagnostics.mock.calls.some((call) =>
                String(call.arguments[0]).includes(
                    'simulated final checkpoint failure'
                )
            )
        )

        failCheckpoint = false
        const retried = await session.navigateTree(emptyLeaf)
        assert.equal(retried.cancelled, false)
        assert.deepEqual(await listed(), [])
        assert.equal(findLatestState(manager.getBranch()), undefined)
        const recovered = manager
            .getEntries()
            .find((entry) => entry.id === recoveredLeaf)
        assert.equal(recovered?.type, 'custom')
        if (recovered?.type !== 'custom')
            assert.fail('missing recovered checkpoint')
        const state = recovered.data as PersistedSubagentStateV2
        assert.equal(
            state.agents.find((agent) => agent.path === '/root/late_result')
                ?.pendingCompletions?.[0]?.communicationId,
            'late-completion-id'
        )
    }
)
