import assert from 'node:assert/strict'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import type { Model } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { DEFAULT_SUBAGENTS_CONFIG } from '../config/config.ts'
import type { AgentRecord } from '../domain/agent-record.ts'
import { AgentStatus } from '../domain/agent-status.ts'
import { AgentBlockedError } from '../domain/errors.ts'
import type { AgentPath } from '../domain/ids.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import { ROOT_PATH } from '../domain/agent-path.ts'
import { SubagentCoordinator } from './coordinator.ts'
import {
    checkOpenedSession,
    checkSessionFile,
    expectedSessionDirectory,
} from './session-recovery.ts'
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

const ROOT_SESSION_ID = 'root-session'

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
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
        ...overrides,
    }
}

function parentSnapshot(): ParentExecutionSnapshot {
    return {
        path: ROOT_PATH,
        cwd: '/repo',
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'medium',
        activeTools: [],
        contextEntries: [],
        sessionId: ROOT_SESSION_ID,
    }
}

function createFactory(options: {
    rootSessionDir: string
    rootSessionId?: string
    config?: typeof DEFAULT_SUBAGENTS_CONFIG
    find?: (provider: string, id: string) => Model<'test-api'> | undefined
}): SessionFactory {
    return new SessionFactory({
        rootSessionId: () => options.rootSessionId ?? ROOT_SESSION_ID,
        rootSessionDir: () => options.rootSessionDir,
        agentDir: join(options.rootSessionDir, 'agent'),
        getModelRegistry: () =>
            ({
                find: options.find ?? (() => MODEL),
            }) as never,
        buildTools: () => [],
        config: options.config ?? DEFAULT_SUBAGENTS_CONFIG,
    })
}

async function createSession(
    factory: SessionFactory,
    record: AgentRecord
): Promise<{ sessionFile: string; sessionId: string }> {
    const runtime = await factory.create(record, parentSnapshot(), {
        _tag: 'None',
    })
    try {
        runtime.session.sessionManager.appendMessage({
            role: 'user',
            content: 'reopen me',
            timestamp: Date.now(),
        } as never)
        return {
            sessionFile: runtime.session.sessionFile!,
            sessionId: runtime.session.sessionId,
        }
    } finally {
        await runtime.dispose()
    }
}

async function assertBlocked(
    action: Promise<unknown>,
    pattern: RegExp
): Promise<AgentBlockedError> {
    try {
        await action
    } catch (error) {
        assert.ok(
            error instanceof AgentBlockedError,
            `expected AgentBlockedError, got ${String(error)}`
        )
        assert.equal(error.code, 'agent_blocked')
        assert.match(error.reason, pattern)
        assert.ok(error.guidance.length > 0)
        return error
    }
    assert.fail('expected the reopen to be blocked')
}

test('checkSessionFile accepts a file inside the expected tree', () => {
    const check = checkSessionFile({
        sessionFile: '/sessions/.subagents/root-session/2026_abc.jsonl',
        rootSessionDir: '/sessions',
        rootSessionId: 'root-session',
        expectedSessionId: 'abc',
    })
    assert.equal(check.ok, true)
    assert.equal(
        check.expectedDir,
        expectedSessionDirectory('/sessions', 'root-session')
    )
})

test('checkSessionFile rejects outside paths, traversal, and unsafe ids', () => {
    const base = {
        rootSessionDir: '/sessions',
        rootSessionId: 'root-session',
        expectedSessionId: 'abc',
    }
    assert.equal(
        checkSessionFile({ ...base, sessionFile: '/other/abc.jsonl' }).ok,
        false
    )
    assert.equal(
        checkSessionFile({
            ...base,
            sessionFile: '/sessions/.subagents/root-session/../abc.jsonl',
        }).ok,
        false
    )
    assert.equal(
        checkSessionFile({
            ...base,
            sessionFile: '/sessions/.subagents/../../abc.jsonl',
        }).ok,
        false
    )
    assert.equal(
        checkSessionFile({
            ...base,
            rootSessionId: '../escape',
            sessionFile: '/sessions/.subagents/root-session/abc.jsonl',
        }).ok,
        false
    )
    assert.equal(
        checkSessionFile({
            ...base,
            sessionFile: '/sessions/.subagents/root-session/def.jsonl',
        }).ok,
        false
    )
    assert.equal(
        checkSessionFile({ ...base, sessionFile: undefined }).ok,
        false
    )
    assert.equal(
        checkSessionFile({
            ...base,
            rootSessionDir: '',
            sessionFile: '/x/abc.jsonl',
        }).ok,
        false
    )
})

test('checkOpenedSession requires matching header, file, meta, and root', () => {
    const facts = {
        sessionFile: '/sessions/.subagents/root-session/2026_abc.jsonl',
        expectedRootSessionId: 'root-session',
        expectedSessionId: 'abc',
        expectedAgentPath: '/root/child',
        expectedParentPath: '/root',
        actualSessionId: 'abc',
        headerId: 'abc',
        meta: {
            rootSessionId: 'root-session',
            path: '/root/child',
            parentPath: '/root',
        },
    }
    assert.equal(checkOpenedSession(facts).ok, true)
    assert.equal(checkOpenedSession({ ...facts, headerId: null }).ok, false)
    assert.equal(checkOpenedSession({ ...facts, headerId: 'other' }).ok, false)
    assert.equal(
        checkOpenedSession({ ...facts, expectedSessionId: 'other' }).ok,
        false
    )
    assert.equal(checkOpenedSession({ ...facts, meta: null }).ok, false)
    assert.equal(
        checkOpenedSession({
            ...facts,
            expectedRecordRootSessionId: 'foreign-root',
        }).ok,
        false
    )
    assert.equal(
        checkOpenedSession({
            ...facts,
            expectedRecordRootSessionId: ROOT_SESSION_ID,
        }).ok,
        true
    )
    assert.equal(
        checkOpenedSession({
            ...facts,
            meta: { ...facts.meta, rootSessionId: 'foreign-root' },
        }).ok,
        false
    )
    assert.equal(
        checkOpenedSession({
            ...facts,
            meta: { ...facts.meta, path: '/root/other' },
        }).ok,
        false
    )
    assert.equal(
        checkOpenedSession({
            ...facts,
            meta: { ...facts.meta, parentPath: '/root/elsewhere' },
        }).ok,
        false
    )
    assert.equal(
        checkOpenedSession({
            ...facts,
            expectedRole: 'reviewer',
        }).ok,
        false
    )
    assert.equal(
        checkOpenedSession({ ...facts, expectedRole: 'default' }).ok,
        true
    )
    assert.equal(
        checkOpenedSession({
            ...facts,
            meta: { ...facts.meta, role: 'default' },
            expectedRole: undefined,
        }).ok,
        true
    )
    // Legacy records without a recorded session id still bind to the header.
    assert.equal(
        checkOpenedSession({ ...facts, expectedSessionId: undefined }).ok,
        true
    )
})

test('valid cold reopen restores the same native session', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({ rootSessionDir: directory })
    const record = agentRecord()
    const { sessionFile, sessionId } = await createSession(factory, record)

    const reopened = await factory.open({
        ...record,
        rootSessionId: ROOT_SESSION_ID,
        sessionFile,
        sessionId,
    })
    try {
        assert.equal(reopened.session.sessionManager.getSessionId(), sessionId)
        assert.equal(reopened.session.sessionFile, sessionFile)
    } finally {
        await reopened.dispose()
    }
})

test('reopen rejects a session file outside the expected directory', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({ rootSessionDir: directory })

    const outsideDir = join(directory, 'elsewhere')
    mkdirSync(outsideDir, { recursive: true })
    const outside = SessionManager.create('/repo', outsideDir)
    outside.appendMessage({
        role: 'user',
        content: 'outside',
        timestamp: Date.now(),
    } as never)

    await assertBlocked(
        factory.open(
            agentRecord({
                sessionFile: outside.getSessionFile(),
                sessionId: outside.getSessionId(),
            })
        ),
        /outside the expected directory|outside /
    )
})

test('reopen rejects path traversal and basename mismatches', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({ rootSessionDir: directory })
    const expectedDir = expectedSessionDirectory(directory, ROOT_SESSION_ID)
    const subagentsRoot = join(directory, '.subagents')
    mkdirSync(subagentsRoot, { recursive: true })

    const escaped = SessionManager.create('/repo', subagentsRoot)
    escaped.appendMessage({
        role: 'user',
        content: 'escape',
        timestamp: Date.now(),
    } as never)
    const traversed = join(
        expectedDir,
        '..',
        basename(escaped.getSessionFile()!)
    )
    await assertBlocked(
        factory.open(
            agentRecord({
                sessionFile: traversed,
                sessionId: escaped.getSessionId(),
            })
        ),
        /outside /
    )

    const child = await createSession(factory, agentRecord())
    await assertBlocked(
        factory.open(
            agentRecord({
                sessionFile: child.sessionFile,
                sessionId: 'different-session',
            })
        ),
        /does not match recorded session/
    )
})

test('reopen rejects a session from a foreign root', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const expectedDir = expectedSessionDirectory(directory, ROOT_SESSION_ID)
    mkdirSync(expectedDir, { recursive: true })
    const session = SessionManager.create('/repo', expectedDir)
    session.appendCustomEntry('subagents-v3-agent-meta', {
        rootSessionId: 'foreign-root',
        path: '/root/child',
        parentPath: '/root',
    })
    session.appendMessage({
        role: 'user',
        content: 'foreign',
        timestamp: Date.now(),
    } as never)

    const factory = createFactory({ rootSessionDir: directory })
    await assertBlocked(
        factory.open(
            agentRecord({
                sessionFile: session.getSessionFile(),
                sessionId: session.getSessionId(),
            })
        ),
        /belongs to root "foreign-root"/
    )
})

test('reopen rejects a record owned by another root', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({ rootSessionDir: directory })
    const record = agentRecord()
    const { sessionFile, sessionId } = await createSession(factory, record)

    await assertBlocked(
        factory.open({
            ...record,
            rootSessionId: 'foreign-root',
            sessionFile,
            sessionId,
        }),
        /the record belongs to root "foreign-root"/
    )
})

test('reopen blocks an unreadable session file', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const expectedDir = expectedSessionDirectory(directory, ROOT_SESSION_ID)
    mkdirSync(expectedDir, { recursive: true })
    const sessionFile = join(expectedDir, 'broken_bad.jsonl')
    writeFileSync(sessionFile, 'not json\n')

    const factory = createFactory({ rootSessionDir: directory })
    await assertBlocked(
        factory.open(agentRecord({ sessionFile, sessionId: 'bad' })),
        /could not be opened/
    )
})

test('reopen rejects a role change recorded after creation', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({
        rootSessionDir: directory,
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            roles: { reviewer: {} },
        },
    })
    const record = agentRecord({ role: 'reviewer' })
    const { sessionFile, sessionId } = await createSession(factory, record)

    await assertBlocked(
        factory.open({
            ...record,
            role: 'default',
            sessionFile,
            sessionId,
        }),
        /created with agent_type "reviewer"/
    )
})

test('reopen blocks a deleted session file without creating one', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({ rootSessionDir: directory })
    const record = agentRecord()
    const { sessionFile, sessionId } = await createSession(factory, record)
    unlinkSync(sessionFile)

    await assertBlocked(
        factory.open({ ...record, sessionFile, sessionId }),
        /does not exist/
    )
    assert.equal(existsSync(sessionFile), false)
})

test('reopen blocks a removed role instead of falling back', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const configured = createFactory({
        rootSessionDir: directory,
        config: {
            ...DEFAULT_SUBAGENTS_CONFIG,
            roles: { reviewer: {} },
        },
    })
    const record = agentRecord({ role: 'reviewer' })
    const { sessionFile, sessionId } = await createSession(configured, record)

    const withoutRole = createFactory({ rootSessionDir: directory })
    await assertBlocked(
        withoutRole.open({ ...record, sessionFile, sessionId }),
        /agent_type "reviewer" is not configured/
    )
})

test('reopen blocks an unresolvable model instead of falling back', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const factory = createFactory({ rootSessionDir: directory })
    const record = agentRecord()
    const { sessionFile, sessionId } = await createSession(factory, record)

    const withoutModel = createFactory({
        rootSessionDir: directory,
        find: () => undefined,
    })
    await assertBlocked(
        withoutModel.open({ ...record, sessionFile, sessionId }),
        /model "test-provider\/test-model" is not available/
    )
})

test('create reports a missing role or model as AgentBlockedError', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))

    const missingRole = createFactory({ rootSessionDir: directory })
    await assertBlocked(
        missingRole.create(
            agentRecord({ role: 'reviewer' }),
            parentSnapshot(),
            { _tag: 'None' }
        ),
        /agent_type "reviewer" is not configured/
    )

    const missingModel = createFactory({
        rootSessionDir: directory,
        find: () => undefined,
    })
    await assertBlocked(
        missingModel.create(agentRecord(), parentSnapshot(), {
            _tag: 'None',
        }),
        /model "test-provider\/test-model" is not available/
    )
})

test('a blocked reopen keeps the record and list() usable', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'subagents-recovery-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const coordinator = new SubagentCoordinator({
        config: DEFAULT_SUBAGENTS_CONFIG,
        getRootSnapshot: () => {
            throw new Error('not used')
        },
        rootEndpoint: {
            path: ROOT_PATH,
            send: async () => undefined,
        },
        rootSessionId: () => ROOT_SESSION_ID,
        rootSessionDir: () => directory,
        getModelRegistry: () => ({ find: () => MODEL }) as never,
        buildTools: () => [],
        sessionFactory: {
            create: async () => {
                throw new Error('not used')
            },
            open: async () => {
                throw new AgentBlockedError(
                    '/root/a',
                    'the recorded session file does not exist',
                    'Start a new agent; no replacement session is created.'
                )
            },
        },
    })
    coordinator.restore({
        version: 2,
        rootSessionId: ROOT_SESSION_ID,
        persistedAt: Date.now(),
        agents: [
            {
                id: 'agent-a',
                path: '/root/a',
                parentPath: '/root',
                rootSessionId: ROOT_SESSION_ID,
                sessionId: 'old-session',
                sessionFile: '/tmp/a.jsonl',
                cwd: '/repo',
                role: 'default',
                model: { provider: 'test-provider', id: 'test-model' },
                thinkingLevel: 'medium',
                activeTools: [],
                status: 'Completed',
                statusMessage: 'done',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                runSequence: 1,
                lastDeliveredRunSequence: 1,
            },
        ],
    })

    await assert.rejects(
        coordinator.sendMessage({
            caller: ROOT_PATH,
            target: '/root/a',
            message: 'resume',
        }),
        /agent_blocked|blocked/
    )
    const listed = coordinator.list(ROOT_PATH)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.path, '/root/a')
    assert.equal(listed[0]?.residency, 'unloaded')
    const record = coordinator.getRecordByPath('/root/a' as AgentPath)
    assert.equal(record?.model, 'test-provider/test-model')
    assert.equal(record?.sessionFile, '/tmp/a.jsonl')
    assert.equal(record?.sessionId, 'old-session')
    await coordinator.shutdown()
})
