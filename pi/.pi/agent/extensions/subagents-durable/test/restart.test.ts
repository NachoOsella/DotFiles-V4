/**
 * Restart and crash recovery tests.
 *
 * The `SIGKILL` cases kill a real subprocess after a durable checkpoint and
 * reopen the same SQLite file, so they exercise abrupt process death rather
 * than a graceful close. Phases covered:
 *
 * - `child-admission`: the child input submission is durable, before the report
 *   checkpoint.
 * - `answer-decision`: the report checkpoint (payload and request ID) is
 *   durable, before the parent submission.
 * - `parent-submission`: the parent report submission is durable, before the
 *   reporter's terminal receipt.
 * - `real-spawn`: the native `spawn_agent` tool's atomic commit (registry,
 *   anchor, child conversation, reporter, operation receipt) is durable, before
 *   the reporter admits the child's initial input. This uses the real extension
 *   and tool path, not the scenario helper.
 *
 * Each SIGKILL case asserts no duplicate logical child, no duplicate reporter,
 * no duplicate child input submission, and one parent report, then reopens a
 * second time to assert stable identity, nesting, and agent configuration.
 *
 * The graceful-close case is a boundary only. `Harness.close` aborts live
 * invocations without writing abort marks, so unfinished checkpoints stay
 * resumable; it is not equivalent to abrupt death.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { AgentDoc } from '@earendil-works/pi-durable'
import type {
    ConversationId,
    EntryRecord,
    Harness,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { SubagentsConfig } from '../src/config/config.js'
import { createSubagentsExtension } from '../src/extension.js'
import type { PassiveWriter } from '../src/extension.js'
import { SubagentsDoc } from '../src/state/subagents-doc.js'
import type { SpawnReceiptDetails } from '../src/state/subagents-doc.js'
import {
    createFauxGate,
    createReporterScenario,
    createTestHarness,
} from '../src/testing/index.js'
import type { TestHarness } from '../src/testing/index.js'

const buildRoot = fileURLToPath(new URL('..', import.meta.url))
const extensionDir = fileURLToPath(new URL('../..', import.meta.url))
const nodeModules = join(extensionDir, '..', '..', 'node_modules')
const durableDist = join(nodeModules, '@earendil-works', 'pi-durable', 'dist')
const piAiDist = join(nodeModules, '@earendil-works', 'pi-ai', 'dist')

const FIXTURE = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const build = process.env.SUBAGENTS_BUILD;
const durable = process.env.SUBAGENTS_DURABLE;
const piAi = process.env.SUBAGENTS_PI_AI;
const database = process.env.SUBAGENTS_DB;
const phase = process.env.SUBAGENTS_PHASE;

const testing = await import(pathToFileURL(join(build, "src/testing/index.js")).href);
const { openNodeSqliteStorage } = await import(pathToFileURL(join(durable, "storage/sqlite/node.js")).href);
const { fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(piAi, "index.js")).href);

const checkpoint = () => {
    process.stdout.write("CHECKPOINT\\n");
    return new Promise(() => {});
};

if (phase === "real-spawn") {
    const { createSubagentsExtension } = await import(pathToFileURL(join(build, "src/extension.js")).href);
    const gate = testing.createGatedStorage(await openNodeSqliteStorage(database), (writes) => writes.some((write) => (write.type === "task" && write.value.kind === "subagents.anchor") || (write.type === "document.create" && write.record.kind === "subagents.operation-receipt")));
    let harnessRef;
    const submitWrite = async (conversationId, draft, context) => {
        const conversation = await harnessRef.conversation(conversationId, context);
        if (conversation === undefined) throw new Error("conversation missing");
        return conversation.submit(draft, context);
    };
    const extension = createSubagentsExtension({ submitWrite });
    const harness = await testing.createTestHarness({ storage: gate.storage, extensions: [extension] });
    harnessRef = harness.harness;
    const root = await harness.harness.root(harness.context);
    await root.configure({ model: { provider: harness.provider, modelId: harness.modelId } }, harness.context);
    harness.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("spawn_agent", { task_name: "worker", message: "do work" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("root final"),
    ]);
    await root.submit({ type: "input", content: "start" }, harness.context);
    await gate.hit;
    await checkpoint();
} else {
    let reporterId;
    const predicate = (writes) => {
        if (phase === "child-admission") {
            return writes.some((write) => write.type === "submission" && typeof write.value.requestId === "string" && write.value.requestId.startsWith("reporter:"));
        }
        if (phase === "parent-submission") {
            return writes.some((write) => write.type === "submission" && typeof write.value.requestId === "string" && write.value.requestId.startsWith("subagents.report:"));
        }
        if (phase === "answer-decision") {
            return writes.some((write) => write.type === "task" && write.value.id === reporterId && write.value.state.status === "running" && write.value.state.checkpoint !== undefined && write.value.state.checkpoint.phase === "report");
        }
        throw new Error("unknown phase " + phase);
    };
    const gate = testing.createGatedStorage(await openNodeSqliteStorage(database), predicate);
    const harness = await testing.createTestHarness({ storage: gate.storage });
    const childGate = testing.createFauxGate("child answer");
    harness.faux.setResponses([childGate.response, fauxAssistantMessage("root answer")]);
    const scenario = await testing.createReporterScenario(harness, { childPath: "/root/worker", parentPath: "/root" });
    reporterId = scenario.reporterId;
    childGate.release();
    await gate.hit;
    await checkpoint();
}
`

async function withDatabase(
    run: (database: string, fixture: string) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(
        join(tmpdir(), 'subagents-durable-restart-')
    )
    const database = join(directory, 'session.sqlite')
    const fixture = join(directory, 'fixture.mjs')
    await writeFile(fixture, FIXTURE, 'utf8')
    try {
        await run(database, fixture)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

function waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve()
    }
    return new Promise((resolve) => child.once('exit', () => resolve()))
}

/**
 * Wait for the fixture's durable checkpoint marker. Rejects on exit, error, or
 * a watchdog so the caller can always kill and reap the child.
 */
function waitForMarker(
    child: ChildProcess,
    marker: string,
    stderr: () => string
): Promise<void> {
    return new Promise((resolve, reject) => {
        let buffer = ''
        const timer = setTimeout(() => {
            cleanup()
            reject(
                new Error(`timed out waiting for ${marker}; stderr=${stderr()}`)
            )
        }, 8_000)
        const cleanup = () => {
            clearTimeout(timer)
            child.stdout?.off('data', onData)
            child.off('exit', onExit)
            child.off('error', onError)
        }
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString()
            if (buffer.includes(marker)) {
                cleanup()
                resolve()
            }
        }
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            reject(
                new Error(
                    `fixture exited before ${marker}: code=${code} signal=${signal} stderr=${stderr()}`
                )
            )
        }
        const onError = (error: Error) => {
            cleanup()
            reject(error)
        }
        child.stdout?.on('data', onData)
        child.once('exit', onExit)
        child.once('error', onError)
    })
}

/** Spawn the fixture, wait for its durable marker, then SIGKILL and reap it. */
async function killFixture(
    phase: string,
    database: string,
    fixture: string
): Promise<void> {
    const child = spawn(process.execPath, [fixture], {
        cwd: extensionDir,
        env: {
            ...process.env,
            SUBAGENTS_BUILD: buildRoot,
            SUBAGENTS_DURABLE: durableDist,
            SUBAGENTS_PI_AI: piAiDist,
            SUBAGENTS_DB: database,
            SUBAGENTS_PHASE: phase,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
    })
    try {
        await waitForMarker(child, 'CHECKPOINT', () => stderr)
    } catch (error) {
        child.kill('SIGKILL')
        await waitForExit(child)
        throw error
    }
    child.kill('SIGKILL')
    await waitForExit(child)
}

async function waitForReporters(harness: TestHarness): Promise<void> {
    const page = await harness.harness.commit(
        (tx) => tx.scanTasks({ kind: 'subagents.reporter' }, 100),
        harness.context
    )
    for (const record of page.items) {
        if (record.state.status !== 'terminal') {
            await harness.harness.waitForTask(record.id, harness.context)
        }
    }
}

type RestartInspection = {
    rootFinals: number
    agentCount: number
    agentPath: string | undefined
    agentParentPath: string | undefined
    agentConversationId: ConversationId | undefined
    childModel: string | undefined
    childThinking: string | undefined
    reporterCount: number
    childInputCount: number
    childInputStatus: string | undefined
    /** Recovered `spawn_agent` tool result, when requested. */
    spawnResult: (SpawnReceiptDetails & { replayed?: boolean }) | undefined
    /** Whether the recovered spawn tool result is an error result. */
    spawnResultIsError: boolean | undefined
    /** Number of `spawn_agent` tool results visible after reopen. */
    spawnResultCount: number | undefined
}

type RestartInspectOptions = {
    /** Install the native extension with this config before reopening. */
    readonly config?: SubagentsConfig
    /** Capture the recovered `spawn_agent` tool result details. */
    readonly captureSpawnResult?: boolean
}

async function createNativeHarness(
    database: string,
    config: SubagentsConfig
): Promise<TestHarness> {
    let current: Harness | undefined
    const submitWrite: PassiveWriter = async (
        conversationId,
        draft,
        context
    ) => {
        const harness = current
        if (harness === undefined) throw new Error('harness not attached')
        const conversation = await harness.conversation(conversationId, context)
        if (conversation === undefined) {
            throw new Error(`Conversation ${conversationId} is missing`)
        }
        return conversation.submit(draft, context)
    }
    const extension = createSubagentsExtension({ config, submitWrite })
    const harness = await createTestHarness({
        storage: await openNodeSqliteStorage(database),
        extensions: [extension],
    })
    current = harness.harness
    return harness
}

type SpawnResultRecord = {
    readonly details: SpawnReceiptDetails & { replayed?: boolean }
    readonly isError: boolean
}

function findSpawnResults(
    entries: readonly EntryRecord[]
): SpawnResultRecord[] {
    const results: SpawnResultRecord[] = []
    for (const entry of entries) {
        if (entry.kind !== 'pi.tool-result') continue
        for (const message of entry.model ?? []) {
            if (
                message.role !== 'toolResult' ||
                message.toolName !== 'spawn_agent'
            ) {
                continue
            }
            const details = (
                message as {
                    details?: SpawnReceiptDetails & { replayed?: boolean }
                }
            ).details
            if (details === undefined) continue
            results.push({
                details,
                isError: (message as { isError?: boolean }).isError === true,
            })
        }
    }
    return results
}

/** Reopen, drive pending work, and inspect every durable identity. */
async function inspectRestart(
    database: string,
    options: RestartInspectOptions = {}
): Promise<RestartInspection> {
    // Always reopen with the real extension and its tasks. A crash after the
    // spawn commit leaves the ToolTask to rerun; without the extension the
    // spawn tool is unavailable and the recovered result would be an error.
    const harness = await createNativeHarness(
        database,
        options.config ?? DEFAULT_CONFIG
    )
    try {
        harness.faux!.setResponses([
            fauxAssistantMessage('child answer'),
            fauxAssistantMessage('root answer'),
        ])
        await waitForReporters(harness)
        const root = await harness.harness.root(harness.context)
        await root.waitForIdle(harness.context)
        const view = await root.context(harness.context)
        const state = await harness.harness.snapshot(
            SubagentsDoc,
            harness.context
        )
        const agents = Object.values(state?.agents ?? {})
        const agent = agents[0]
        const reporters = await harness.harness.commit(
            (tx) => tx.scanTasks({ kind: 'subagents.reporter' }, 100),
            harness.context
        )
        const childInputs =
            agent === undefined
                ? []
                : (
                      await harness.storage.scanSubmissions(
                          { conversationId: agent.conversationId },
                          100,
                          undefined,
                          harness.context
                      )
                  ).items.filter((record) =>
                      record.requestId?.startsWith('reporter:')
                  )
        const childAgent =
            agent === undefined
                ? undefined
                : await harness.harness.snapshot(
                      AgentDoc,
                      agent.conversationId,
                      harness.context
                  )
        const childConversation =
            agent === undefined
                ? undefined
                : await harness.harness.conversation(
                      agent.conversationId,
                      harness.context
                  )
        const childResolved =
            childConversation === undefined
                ? undefined
                : await childConversation.agent(harness.context)
        const spawnResults = options.captureSpawnResult
            ? findSpawnResults(view.entries)
            : []
        return {
            rootFinals: view.entries.filter((entry) =>
                JSON.stringify(entry.model ?? []).includes('FINAL_ANSWER')
            ).length,
            agentCount: agents.length,
            agentPath: agent?.path,
            agentParentPath: agent?.parentPath,
            agentConversationId: agent?.conversationId,
            childModel:
                childAgent?.model === undefined
                    ? undefined
                    : `${childAgent.model.provider}/${childAgent.model.modelId}`,
            childThinking: childResolved?.thinkingLevel,
            reporterCount: reporters.items.length,
            childInputCount: childInputs.length,
            childInputStatus: childInputs[0]?.status,
            spawnResult: spawnResults[0]?.details,
            spawnResultIsError: options.captureSpawnResult
                ? spawnResults[0]?.isError
                : undefined,
            spawnResultCount: options.captureSpawnResult
                ? spawnResults.length
                : undefined,
        }
    } finally {
        await harness.harness.close(harness.context)
    }
}

function assertSingleRecoveredChild(inspection: RestartInspection): void {
    assert.equal(inspection.rootFinals, 1)
    assert.equal(inspection.agentCount, 1)
    assert.equal(inspection.agentPath, '/root/worker')
    assert.equal(inspection.agentParentPath, '/root')
    assert.ok(inspection.agentConversationId !== undefined)
    assert.equal(inspection.reporterCount, 1)
    assert.equal(inspection.childInputCount, 1)
    assert.equal(inspection.childInputStatus, 'done')
}

test(
    'SIGKILL after child input admission recovers one logical child',
    { timeout: 15_000 },
    async () => {
        await withDatabase(async (database, fixture) => {
            await killFixture('child-admission', database, fixture)
            const first = await inspectRestart(database)
            assertSingleRecoveredChild(first)
            const second = await inspectRestart(database)
            assert.equal(second.agentConversationId, first.agentConversationId)
            assert.equal(second.agentParentPath, '/root')
            assert.equal(second.childModel, first.childModel)
            assertSingleRecoveredChild(second)
        })
    }
)

test(
    'SIGKILL after the answer decision recovers one logical child',
    { timeout: 15_000 },
    async () => {
        await withDatabase(async (database, fixture) => {
            await killFixture('answer-decision', database, fixture)
            const first = await inspectRestart(database)
            assertSingleRecoveredChild(first)
            const second = await inspectRestart(database)
            assert.equal(second.agentConversationId, first.agentConversationId)
            assert.equal(second.childModel, first.childModel)
            assertSingleRecoveredChild(second)
        })
    }
)

test(
    'SIGKILL after the parent submission recovers one logical child',
    { timeout: 15_000 },
    async () => {
        await withDatabase(async (database, fixture) => {
            await killFixture('parent-submission', database, fixture)
            const first = await inspectRestart(database)
            assertSingleRecoveredChild(first)
            const second = await inspectRestart(database)
            assert.equal(second.agentConversationId, first.agentConversationId)
            assert.equal(second.childModel, first.childModel)
            assertSingleRecoveredChild(second)
        })
    }
)

test(
    'SIGKILL after the native spawn commit recovers stable identities',
    { timeout: 20_000 },
    async () => {
        await withDatabase(async (database, fixture) => {
            await killFixture('real-spawn', database, fixture)
            const first = await inspectRestart(database, {
                captureSpawnResult: true,
            })
            assertSingleRecoveredChild(first)
            assert.ok(first.childModel !== undefined)
            assert.ok(first.spawnResult !== undefined)
            assert.equal(first.spawnResultIsError, false)
            assert.equal(first.spawnResultCount, 1)
            assert.equal(first.spawnResult.replayed, true)
            assert.equal(first.spawnResult.task_name, '/root/worker')
            assert.equal(first.spawnResult.model, first.childModel)

            const second = await inspectRestart(database, {
                captureSpawnResult: true,
            })
            assert.equal(second.agentConversationId, first.agentConversationId)
            assert.equal(second.agentParentPath, '/root')
            assert.equal(second.childModel, first.childModel)
            assertSingleRecoveredChild(second)
            assert.equal(second.spawnResultCount, 1)
            assert.equal(second.spawnResultIsError, false)
        })
    }
)

/**
 * The receipt stores the spawn tool response atomically with creation. A
 * reopened harness with different metadata/role/config must still return the
 * original details, matching the child's persisted `pi.agent`, rather than
 * recomputing them under the new configuration.
 */
test(
    'recovered spawn result preserves original details after a config change',
    { timeout: 20_000 },
    async () => {
        await withDatabase(async (database, fixture) => {
            await killFixture('real-spawn', database, fixture)
            const inspection = await inspectRestart(database, {
                config: { ...DEFAULT_CONFIG, hideSpawnAgentMetadata: true },
                captureSpawnResult: true,
            })
            assertSingleRecoveredChild(inspection)
            const details = inspection.spawnResult
            assert.ok(details !== undefined)
            assert.equal(details.task_name, '/root/worker')
            assert.equal(details.replayed, true)
            assert.ok(details.model !== undefined)
            assert.equal(details.model, inspection.childModel)
            assert.ok(details.thinking_level !== undefined)
            assert.equal(details.thinking_level, inspection.childThinking)
            assert.equal(details.agent_type, undefined)
        })
    }
)

test(
    'graceful close during generation resumes to one report',
    { timeout: 15_000 },
    async () => {
        await withDatabase(async (database) => {
            const gate = createFauxGate('child answer')
            const harness = await createTestHarness({
                storage: await openNodeSqliteStorage(database),
            })
            harness.faux!.setResponses([
                gate.response,
                fauxAssistantMessage('root answer'),
            ])
            await createReporterScenario(harness, {
                childPath: '/root/worker',
                parentPath: '/root',
            })
            await gate.started
            // Close aborts the live invocation but writes no abort mark, so the
            // checkpoint stays resumable. This is a boundary, not abrupt death:
            // reopening resumes the same work and still reports exactly once.
            await harness.harness.close(harness.context)

            const reopened = await createTestHarness({
                storage: await openNodeSqliteStorage(database),
            })
            try {
                reopened.faux!.setResponses([
                    fauxAssistantMessage('child answer'),
                    fauxAssistantMessage('root answer'),
                ])
                await waitForReporters(reopened)
                const root = await reopened.harness.root(reopened.context)
                await root.waitForIdle(reopened.context)
                const view = await root.context(reopened.context)
                assert.equal(
                    view.entries.filter((entry) =>
                        JSON.stringify(entry.model ?? []).includes(
                            'FINAL_ANSWER'
                        )
                    ).length,
                    1
                )
            } finally {
                await reopened.harness.close(reopened.context)
            }
        })
    }
)
