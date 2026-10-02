import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import subagentsExtension from '../../index.ts'
import {
    findLatestState,
    SUBAGENTS_STATE_CUSTOM_TYPE,
} from './session-state.ts'
import type { PersistedSubagentStateV2 } from './schema.ts'

async function createSession(
    cwd: string,
    agentDir: string,
    sessionManager: SessionManager
): Promise<AgentSession> {
    const settingsManager = SettingsManager.create(cwd, agentDir)
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noThemes: true,
        noExtensions: true,
        extensionFactories: [subagentsExtension],
    })
    await resourceLoader.reload()
    assert.deepEqual(resourceLoader.getExtensions().errors, [])
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader,
        sessionManager,
        tools: ['list_agents'],
    })
    await session.bindExtensions({
        onError: (error) => assert.fail(error.error),
    })
    return session
}

async function assertChildListed(session: AgentSession): Promise<void> {
    const tool = session.agent.state.tools.find(
        (tool) => tool.name === 'list_agents'
    )
    assert.ok(tool)
    const result = await tool.execute('list', {
        path_prefix: '/root/reviewer',
    })
    const details = result.details as {
        agents: Array<{ agent_name: string }>
    }
    assert.deepEqual(
        details.agents.map((agent) => agent.agent_name),
        ['/root/reviewer']
    )
}

test('subagents survive reload, shutdown, and reopening the root session', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-lifecycle-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const agentDir = join(directory, 'agent')
    const manager = SessionManager.create(
        directory,
        join(directory, 'sessions')
    )
    manager.appendMessage({
        role: 'user',
        content: 'Review the project.',
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
    manager.appendCustomEntry(SUBAGENTS_STATE_CUSTOM_TYPE, snapshot)
    const sessionFile = manager.getSessionFile()
    assert.ok(sessionFile)

    const session = await createSession(directory, agentDir, manager)
    try {
        await assertChildListed(session)
        await session.reload()
        await assertChildListed(session)
        await session.extensionRunner.emit({
            type: 'session_shutdown',
            reason: 'quit',
        })
        const persisted = findLatestState(manager.getBranch())
        assert.deepEqual(
            persisted?.agents.map((agent) => agent.path),
            ['/root/reviewer']
        )
    } finally {
        session.dispose()
    }

    const reopened = await createSession(
        directory,
        agentDir,
        SessionManager.open(sessionFile)
    )
    try {
        await assertChildListed(reopened)
    } finally {
        reopened.dispose()
    }
})
