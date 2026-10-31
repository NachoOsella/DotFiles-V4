import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Model } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import type { AgentPath } from '../domain/ids.ts'
import { SessionFactory } from './session-factory.ts'

const MODEL: Model<'test-api'> = {
    id: 'test-model',
    name: 'Test model',
    api: 'test-api',
    provider: 'test-provider',
    baseUrl: 'http://test.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
}

function record(): AgentRecord {
    return {
        id: 'agent-1' as AgentRecord['id'],
        path: '/root/child' as AgentPath,
        parentId: 'root' as AgentRecord['id'],
        parentPath: '/root' as AgentPath,
        status: AgentStatus.pendingInit(),
        residency: 'loading',
        model: 'test-provider/test-model',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        activeTools: [],
    }
}

function parent(): ParentExecutionSnapshot {
    const session = SessionManager.inMemory('/repo')
    session.appendMessage({
        role: 'user',
        content: 'inherited task',
        timestamp: Date.now(),
    } as never)
    return {
        path: '/root' as AgentPath,
        cwd: '/repo',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium',
        activeTools: [],
        contextEntries: session.getBranch(),
        sessionId: 'root-session',
    }
}

test('loader and session share the intended agentDir settings, including reopen', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-settings-'))
    const agentDir = join(root, 'agent')
    const decoyDir = join(root, 'decoy')
    mkdirSync(agentDir)
    mkdirSync(decoyDir)
    writeFileSync(
        join(agentDir, 'settings.json'),
        JSON.stringify({ steeringMode: 'all', compaction: { enabled: false } })
    )
    // The regression: createAgentSession ignored agentDir and read this
    // process-wide directory instead.
    writeFileSync(
        join(decoyDir, 'settings.json'),
        JSON.stringify({
            steeringMode: 'one-at-a-time',
            compaction: { enabled: true },
        })
    )

    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = decoyDir
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = previous
        rmSync(root, { recursive: true, force: true })
    })

    const factory = new SessionFactory({
        rootSessionId: () => 'root-session',
        rootSessionDir: () => root,
        agentDir,
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        config: DEFAULT_SUBAGENTS_CONFIG,
    })
    const child = record()
    const runtime = await factory.create(child, parent(), { _tag: 'All' })
    let sessionFile: string
    try {
        assert.equal(runtime.session.settingsManager.getSteeringMode(), 'all')
        assert.equal(
            runtime.session.settingsManager.getCompactionEnabled(),
            false
        )
        runtime.session.sessionManager.appendMessage({
            role: 'user',
            content: 'child prompt',
            timestamp: Date.now(),
        } as never)
        sessionFile = runtime.session.sessionFile!
        assert.ok(sessionFile)
    } finally {
        await runtime.dispose()
    }

    // A different environment value must not change a cold reopen either.
    process.env.PI_CODING_AGENT_DIR = agentDir
    const reopened = await factory.open({ ...child, sessionFile })
    try {
        assert.equal(reopened.session.settingsManager.getSteeringMode(), 'all')
        assert.equal(
            reopened.session.settingsManager.getCompactionEnabled(),
            false
        )
        assert.match(
            JSON.stringify(
                reopened.session.sessionManager.buildSessionContext().messages
            ),
            /inherited task/
        )
        assert.equal(reopened.session.getSessionStats().cost, 0)
    } finally {
        await reopened.dispose()
    }
})
