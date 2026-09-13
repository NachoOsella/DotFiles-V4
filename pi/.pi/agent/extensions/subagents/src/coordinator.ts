import {
    InvalidTaskNameError,
    isRootPath,
    isValidTaskName,
    joinAgentPath,
    parentAgentPath,
    pathMatchesPrefix,
    resolveTarget,
    ROOT_PATH,
} from './agent-path.ts'
import { AgentStatus, type AgentResidency } from './agent-status.ts'
import { ActivityFeed } from './activity-feed.ts'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { AgentRecord, AgentUsageTotals } from './agent-record.ts'
import {
    assertNonEmptyMessage,
    finalAnswerCommunication,
    newTaskCommunication,
    plainMessageCommunication,
    parseForkTurns,
    type ForkTurns,
} from './communication.ts'
import { formatFinalAnswer } from './completion.ts'
import {
    AgentAlreadyExistsError,
    AgentCapacityReachedError,
    AgentLoadFailedError,
    AgentNotFoundError,
    AgentSpawnFailedError,
    InvalidModelOverrideError,
    RootFollowupForbiddenError,
    SelfInterruptForbiddenError,
} from './errors.ts'
import {
    newAgentId,
    newTurnId,
    type AgentId,
    type AgentPath,
    type ToolCallId,
} from './ids.ts'
import type { ParentExecutionSnapshot } from './parent-snapshot.ts'
import { resolveRole } from './roles.ts'
import { AgentMutex, type AgentRuntime } from './agent-runtime.ts'
import { ExecutionLimiter } from './execution-limiter.ts'
import { childEndpoint, type CommunicationEndpoint } from './transport.ts'
import {
    SessionFactory,
    type SubagentSessionFactory,
} from './session-factory.ts'
import { WaitHub } from './wait-hub.ts'
import { clampV3WaitTimeout, type CodexSubagentsConfig } from './config.ts'
import type { SubagentEvent } from './events.ts'
import type { PersistedSubagentStateV2 } from './persistence-v3.ts'

export interface ListedAgent {
    readonly path: AgentPath
    readonly status: AgentRecord['status']['_tag']
    readonly residency: AgentResidency
    readonly role?: string
    readonly model: string
    readonly parentPath: AgentPath | null
    readonly hasPendingMail: boolean
    readonly running: boolean
}

export interface CoordinatorSpawnOptions {
    readonly caller: AgentPath
    readonly taskName: string
    readonly message: string
    readonly forkTurns?: string
    readonly agentType?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly callId?: ToolCallId
}

export interface SpawnResult {
    readonly path: AgentPath
    readonly id: AgentId
}

export interface WaitResult {
    readonly message: string
    readonly timedOut: boolean
}

export interface AgentTurnPreview {
    readonly role: string
    readonly text: string
}

export interface SubagentCoordinatorOptions {
    readonly config: CodexSubagentsConfig
    readonly getRootSnapshot: () => ParentExecutionSnapshot
    readonly rootEndpoint: CommunicationEndpoint
    readonly rootSessionId: () => string
    readonly rootSessionDir: () => string
    readonly getModelRegistry: () => import('@earendil-works/pi-coding-agent').ModelRegistry
    readonly buildTools: (caller: AgentPath) => readonly unknown[]
    readonly sessionFactory?: SubagentSessionFactory
}

const WAIT_COMPLETED = 'Wait completed.'
const WAIT_INTERRUPTED = 'Wait interrupted by new input.'
const WAIT_TIMED_OUT = 'Wait timed out.'

/**
 * Coordinates identities and communication while Pi owns every conversation,
 * queue, run lifecycle, and persisted transcript.
 */
export class SubagentCoordinator {
    private readonly options: SubagentCoordinatorOptions
    private readonly records = new Map<AgentId, AgentRecord>()
    private readonly pathIndex = new Map<string, AgentId>()
    private readonly runtimes = new Map<AgentId, AgentRuntime>()
    /** Shares one cold reopen across concurrent send/follow-up callers. */
    private readonly loading = new Map<AgentId, Promise<AgentRuntime>>()
    private readonly recentTurns = new Map<
        AgentId,
        readonly AgentTurnPreview[]
    >()
    private readonly registryMutex = new AgentMutex()
    private readonly residencyMutex = new AgentMutex()
    private readonly mutexes = new Map<AgentId, AgentMutex>()
    private readonly listeners = new Set<(event: SubagentEvent) => void>()
    private readonly sessionBindings = new Map<string, AgentId>()
    private readonly waitHub = new WaitHub()
    private readonly activityFeed = new ActivityFeed()
    private readonly limiter: ExecutionLimiter
    private readonly factory: SubagentSessionFactory
    private readonly rootId: AgentId
    private shutdownFlag = false

    constructor(options: SubagentCoordinatorOptions) {
        this.options = options
        this.limiter = new ExecutionLimiter(
            options.config.maxConcurrentExecutions
        )
        this.rootId = newAgentId()
        const snapshot = safeRootSnapshot(options.getRootSnapshot)
        const root: AgentRecord = {
            id: this.rootId,
            path: ROOT_PATH,
            parentId: null,
            parentPath: null,
            status: AgentStatus.running(),
            residency: 'loaded',
            model: snapshot
                ? `${snapshot.model.provider}/${snapshot.model.id}`
                : 'root',
            activeTools: snapshot?.activeTools,
            thinkingLevel: snapshot?.thinkingLevel,
            sessionId: snapshot?.sessionId,
            sessionFile: snapshot?.sessionFile,
            rootSessionId: snapshot?.sessionId,
            cwd: snapshot?.cwd,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            runSequence: 0,
        }
        this.records.set(this.rootId, root)
        this.pathIndex.set(ROOT_PATH as string, this.rootId)

        this.factory =
            options.sessionFactory ??
            new SessionFactory({
                rootSessionId: options.rootSessionId,
                rootSessionDir: options.rootSessionDir,
                getModelRegistry: options.getModelRegistry,
                buildTools: options.buildTools,
                config: options.config,
                onActivity: (path, summary) => {
                    const record = this.getRecordByPath(path)
                    if (!record) return
                    this.touch(record.id)
                    this.activityFeed.push(
                        path as string,
                        summary === 'thinking' ? 'thinking' : 'tool',
                        summary
                    )
                    this.emit({
                        _tag: 'ToolActivity',
                        agentId: record.id,
                        summary,
                    })
                },
            })
    }

    onEvent(listener: (event: SubagentEvent) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    private emit(event: SubagentEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event)
            } catch {
                // UI and telemetry listeners must not affect lifecycle state.
            }
        }
    }

    getConfig(): CodexSubagentsConfig {
        return this.options.config
    }

    getRecordByPath(path: AgentPath): AgentRecord | undefined {
        const id = this.pathIndex.get(path as string)
        return id ? this.records.get(id) : undefined
    }

    getRecordById(id: AgentId): AgentRecord | undefined {
        return this.records.get(id)
    }

    getActivity(path: AgentPath) {
        return this.activityFeed.get(path as string)
    }

    getRecentTurns(path: AgentPath): readonly AgentTurnPreview[] {
        const record = this.getRecordByPath(path)
        if (!record) return []
        const runtime = this.runtimes.get(record.id)
        if (runtime) this.captureRecentTurns(record.id, runtime)
        return this.recentTurns.get(record.id) ?? []
    }

    bindSession(sessionId: string, path: AgentPath): void {
        const id = this.pathIndex.get(path as string)
        if (id) this.sessionBindings.set(sessionId, id)
    }

    callerFromSession(sessionId: string | undefined): AgentPath {
        if (!sessionId) return ROOT_PATH
        const id = this.sessionBindings.get(sessionId)
        return this.records.get(id ?? this.rootId)?.path ?? ROOT_PATH
    }

    list(from: AgentPath, prefix?: string): ListedAgent[] {
        void from
        return [...this.records.values()]
            .filter((record) => record.path !== ROOT_PATH)
            .filter(
                (record) => !prefix || pathMatchesPrefix(record.path, prefix)
            )
            .map((record) => {
                const runtime = this.runtimes.get(record.id)
                return {
                    path: record.path,
                    status: record.status._tag,
                    residency: record.residency,
                    role: record.role,
                    model: record.model,
                    parentPath: record.parentPath,
                    hasPendingMail: this.waitHub.hasPending(
                        record.path as string
                    ),
                    running: runtime?.session.isStreaming ?? false,
                }
            })
            .sort((left, right) =>
                left.path < right.path ? -1 : left.path > right.path ? 1 : 0
            )
    }

    resolve(from: AgentPath, target: string): AgentRecord {
        const path = resolveTarget(from, target)
        const record = this.getRecordByPath(path)
        if (!record) throw new AgentNotFoundError(path as string)
        return record
    }

    async spawn(options: CoordinatorSpawnOptions): Promise<SpawnResult> {
        if (this.shutdownFlag) {
            throw new AgentSpawnFailedError('session is shutting down')
        }
        assertNonEmptyMessage(options.message)
        if (!isValidTaskName(options.taskName)) {
            throw new InvalidTaskNameError(options.taskName)
        }
        const caller = this.getRecordByPath(options.caller)
        if (!caller) throw new AgentNotFoundError(options.caller as string)
        const fork = parseForkTurns(options.forkTurns)
        if (
            fork._tag === 'All' &&
            (options.model !== undefined ||
                options.reasoningEffort !== undefined)
        ) {
            throw new InvalidModelOverrideError(
                'model and reasoning_effort overrides are not allowed with fork_turns=all'
            )
        }
        if (
            (options.model !== undefined ||
                options.reasoningEffort !== undefined) &&
            !this.options.config.exposeSpawnAgentModelOverrides
        ) {
            throw new InvalidModelOverrideError(
                'model overrides are not exposed; omit model/reasoning_effort'
            )
        }

        const childPath = joinAgentPath(options.caller, options.taskName)
        const parentSnapshot = await this.snapshotFor(caller)
        const inheritsExecution = fork._tag === 'All'
        const role = resolveRole(
            this.options.config,
            options.agentType ?? (inheritsExecution ? caller.role : undefined)
        )
        const thinkingOverride = parseThinkingLevel(options.reasoningEffort)
        const model = inheritsExecution
            ? (role.model ?? formatModel(parentSnapshot.model))
            : (options.model ?? role.model ?? formatModel(parentSnapshot.model))
        const record: AgentRecord = {
            id: newAgentId(),
            path: childPath,
            parentId: caller.id,
            parentPath: caller.path,
            status: AgentStatus.pendingInit(),
            residency: 'loading',
            role: role.name,
            model,
            reasoningEffort: options.reasoningEffort,
            cwd: parentSnapshot.cwd,
            activeTools: [
                ...new Set([
                    ...parentSnapshot.activeTools,
                    ...(role.tools ?? []),
                ]),
            ],
            thinkingLevel: inheritsExecution
                ? (role.thinkingLevel ?? parentSnapshot.thinkingLevel)
                : (thinkingOverride ??
                  role.thinkingLevel ??
                  parentSnapshot.thinkingLevel),
            rootSessionId: this.options.rootSessionId(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            runSequence: 0,
            initiatingTurnId: newTurnId() as string,
            forkKind: fork._tag,
        }
        let initialization!: Promise<AgentRuntime>
        await this.registryMutex.runExclusive(async () => {
            this.assertSpawnReservationAvailable(childPath)
            this.records.set(record.id, record)
            this.pathIndex.set(childPath as string, record.id)
            initialization = this.initializeSpawnRuntime(
                record,
                { ...parentSnapshot, model: parseModel(model) },
                fork
            )
            this.trackLoading(record.id, initialization)
        })

        try {
            await initialization
            const comm = newTaskCommunication({
                kind: 'spawn',
                author: caller.path,
                recipient: childPath,
                payload: options.message,
                sourceCallId: options.callId,
            })
            await this.startRun(record.id, comm)
            this.emit({
                _tag: 'ActivityStarted',
                callId: options.callId ?? (`spawn-${Date.now()}` as ToolCallId),
                agentId: record.id,
                agentPath: childPath,
                parentTurnId: record.initiatingTurnId as never,
            })
            return { path: childPath, id: record.id }
        } catch (error) {
            await this.residencyMutex.runExclusive(async () => {
                const runtime = this.runtimes.get(record.id)
                if (runtime) await runtime.dispose().catch(() => undefined)
                this.runtimes.delete(record.id)
            })
            await this.registryMutex.runExclusive(async () => {
                this.pathIndex.delete(childPath as string)
                this.records.delete(record.id)
            })
            throw error instanceof Error
                ? error
                : new AgentSpawnFailedError(String(error))
        }
    }

    async sendMessage(args: {
        caller: AgentPath
        target: string
        message: string
        callId?: ToolCallId
    }): Promise<void> {
        assertNonEmptyMessage(args.message)
        const target = this.resolve(args.caller, args.target)
        const runtime = await this.ensureLoaded(target.id)
        const comm = plainMessageCommunication({
            author: args.caller,
            recipient: target.path,
            payload: args.message,
            sourceCallId: args.callId,
        })
        await this.mutex(target.id).runExclusive(async () => {
            await runtime.endpoint!.send(comm, { triggerTurn: false })
        })
        this.touch(target.id)
        this.waitHub.notifyMailbox(target.path as string)
        this.emit({
            _tag: 'ActivityInteracted',
            callId: args.callId ?? (`msg-${Date.now()}` as ToolCallId),
            agentId: target.id,
            agentPath: target.path,
        })
    }

    async followup(args: {
        caller: AgentPath
        target: string
        message: string
        callId?: ToolCallId
    }): Promise<void> {
        assertNonEmptyMessage(args.message)
        const targetPath = resolveTarget(args.caller, args.target)
        if (isRootPath(targetPath)) throw new RootFollowupForbiddenError()
        const target = this.getRecordByPath(targetPath)
        if (!target) throw new AgentNotFoundError(targetPath as string)
        const runtime = await this.ensureLoaded(target.id)
        const comm = newTaskCommunication({
            kind: 'followup',
            author: args.caller,
            recipient: target.path,
            payload: args.message,
            sourceCallId: args.callId,
        })
        await this.mutex(target.id).runExclusive(async () => {
            if (runtime.phase === 'running' && runtime.session.isStreaming) {
                await runtime.endpoint!.send(comm, {
                    triggerTurn: true,
                    delivery: 'steer',
                })
                this.waitHub.notifySteer(target.path as string)
                return
            }
            if (runtime.currentRun) {
                await runtime.currentRun.catch(() => undefined)
            }
            await this.startRun(target.id, comm)
        })
        this.touch(target.id)
        this.emit({
            _tag: 'ActivityInteracted',
            callId: args.callId ?? (`followup-${Date.now()}` as ToolCallId),
            agentId: target.id,
            agentPath: target.path,
        })
    }

    async interrupt(args: {
        caller: AgentPath
        target: string
        callId?: ToolCallId
    }): Promise<AgentRecord['status']> {
        const targetPath = resolveTarget(args.caller, args.target)
        if (isRootPath(targetPath) || targetPath === args.caller) {
            throw new SelfInterruptForbiddenError()
        }
        const target = this.getRecordByPath(targetPath)
        if (!target) throw new AgentNotFoundError(targetPath as string)
        const runtime = this.runtimes.get(target.id)
        if (!runtime?.session.isStreaming && !runtime?.currentRun) {
            return target.status
        }
        runtime.interruptRequested = true
        await runtime.session.abort().catch(() => undefined)
        await runtime.currentRun?.catch(() => undefined)
        this.emit({
            _tag: 'ActivityInterrupted',
            callId: args.callId ?? (`interrupt-${Date.now()}` as ToolCallId),
            agentId: target.id,
            agentPath: target.path,
        })
        return this.records.get(target.id)?.status ?? AgentStatus.interrupted()
    }

    async wait(args: {
        caller: AgentPath
        timeoutMs?: number
    }): Promise<WaitResult> {
        const caller = this.getRecordByPath(args.caller)
        if (!caller) throw new AgentNotFoundError(args.caller as string)
        const clamped = clampV3WaitTimeout(this.options.config, args.timeoutMs)
        if (clamped.rejected) throw new Error(clamped.rejected)
        const outcome = await this.waitHub.wait(
            caller.path as string,
            clamped.effectiveMs
        )
        if (outcome.timedOut) {
            return {
                message: withNote(WAIT_TIMED_OUT, clamped.note),
                timedOut: true,
            }
        }
        return {
            message: withNote(
                outcome.kind === 'steer' ? WAIT_INTERRUPTED : WAIT_COMPLETED,
                clamped.note
            ),
            timedOut: false,
        }
    }

    notifySteer(path: AgentPath): void {
        this.waitHub.notifySteer(path as string)
    }

    async shutdown(): Promise<void> {
        this.shutdownFlag = true
        await Promise.allSettled([...this.loading.values()])
        const runtimes = [...this.runtimes.values()]
        for (const runtime of runtimes) {
            runtime.interruptRequested = true
            await runtime.session.abort().catch(() => undefined)
        }
        await Promise.all(
            runtimes.map((runtime) =>
                runtime.currentRun?.catch(() => undefined)
            )
        )
        await Promise.all(runtimes.map((runtime) => runtime.dispose()))
        this.runtimes.clear()
        this.loading.clear()
        this.waitHub.clear()
        this.activityFeed.clear()
    }

    serialize(rootSessionId: string): PersistedSubagentStateV2 {
        return {
            version: 2,
            rootSessionId,
            persistedAt: Date.now(),
            agents: [...this.records.values()]
                .filter((record) => record.path !== ROOT_PATH)
                .map((record) => ({
                    id: record.id,
                    path: record.path,
                    parentPath: record.parentPath,
                    rootSessionId: record.rootSessionId ?? rootSessionId,
                    sessionId: record.sessionId,
                    sessionFile: record.sessionFile,
                    cwd: record.cwd,
                    role: record.role,
                    model: parseModel(record.model),
                    thinkingLevel: record.thinkingLevel,
                    activeTools: record.activeTools ?? [],
                    status: record.status._tag,
                    statusMessage: terminalMessage(record),
                    createdAt: record.createdAt,
                    lastActivityAt: record.lastActivityAt,
                    runSequence: record.runSequence ?? 0,
                    lastDeliveredRunSequence: record.lastDeliveredRunSequence,
                    lastResult: record.lastResult,
                    legacyUnresumable: record.legacyUnresumable,
                    usage: record.usage,
                })),
        }
    }

    restore(
        state:
            | PersistedSubagentStateV2
            | { version: 1; rootSessionId?: string; agents: readonly any[] }
    ): void {
        const currentRootSessionId = this.options.rootSessionId()
        if (
            state.rootSessionId &&
            currentRootSessionId !== 'unknown-root' &&
            state.rootSessionId !== currentRootSessionId
        ) {
            return
        }
        if (state.version === 1) {
            for (const legacy of state.agents) {
                if (this.pathIndex.has(legacy.path)) continue
                const path = legacy.path as AgentPath
                const record: AgentRecord = {
                    id: legacy.id as AgentId,
                    path,
                    parentId: (legacy.parentId ?? null) as AgentId | null,
                    parentPath: parentAgentPath(path),
                    role: legacy.role,
                    model: legacy.model,
                    status: restoredStatus(
                        legacy.statusTag,
                        legacy.statusMessage
                    ),
                    residency: 'unloaded',
                    createdAt: legacy.createdAt,
                    lastActivityAt: legacy.lastActivityAt,
                    legacyUnresumable: true,
                }
                this.records.set(record.id, record)
                this.pathIndex.set(path as string, record.id)
            }
            return
        }
        if (state.version !== 2)
            throw new Error('unsupported persisted version')
        for (const persisted of state.agents) {
            if (this.pathIndex.has(persisted.path)) continue
            const path = persisted.path as AgentPath
            const record: AgentRecord = {
                id: persisted.id as AgentId,
                path,
                parentId: null,
                parentPath: persisted.parentPath as AgentPath | null,
                rootSessionId: persisted.rootSessionId,
                sessionId: persisted.sessionId,
                sessionFile: persisted.sessionFile,
                cwd: persisted.cwd,
                role: persisted.role,
                model: formatModel(persisted.model),
                thinkingLevel: persisted.thinkingLevel,
                activeTools: persisted.activeTools,
                status: restoredStatus(
                    persisted.status,
                    persisted.statusMessage
                ),
                residency: 'unloaded',
                createdAt: persisted.createdAt,
                lastActivityAt: persisted.lastActivityAt,
                runSequence: persisted.runSequence,
                lastDeliveredRunSequence: persisted.lastDeliveredRunSequence,
                lastResult: persisted.lastResult,
                legacyUnresumable: persisted.legacyUnresumable,
                usage: persisted.usage,
            }
            this.records.set(record.id, record)
            this.pathIndex.set(path as string, record.id)
        }
    }

    private async startRun(
        id: AgentId,
        comm: ReturnType<typeof newTaskCommunication>
    ): Promise<void> {
        const record = this.records.get(id)
        const runtime = this.runtimes.get(id)
        if (!record || !runtime) throw new AgentNotFoundError(String(id))
        if (
            runtime.currentRun ||
            runtime.phase !== 'idle' ||
            runtime.session.isStreaming
        )
            return
        const permit = this.limiter.tryAcquire()
        runtime.runSequence += 1
        runtime.activePermitSequence = permit.sequence
        runtime.interruptRequested = false
        runtime.phase = 'running'
        this.setRecord(id, (previous) => ({
            ...previous,
            status: AgentStatus.running(),
            runSequence: runtime.runSequence,
        }))
        const sequence = runtime.runSequence
        let runPromise: Promise<void>
        try {
            runPromise = runtime.endpoint!.send(comm, {
                triggerTurn: true,
            })
        } catch (error) {
            permit.release()
            runtime.activePermitSequence = undefined
            runtime.phase = 'idle'
            runtime.interruptRequested = false
            throw error
        }
        const tracked = runPromise
            .then(() => this.settleRun(id, sequence, undefined, permit))
            .catch((error) => this.settleRun(id, sequence, error, permit))
        runtime.currentRun = tracked
    }

    private async settleRun(
        id: AgentId,
        sequence: number,
        error: unknown,
        permit: { sequence: number; release(): void }
    ): Promise<void> {
        const record = this.records.get(id)
        const runtime = this.runtimes.get(id)
        if (!record || !runtime || runtime.runSequence !== sequence) {
            permit.release()
            return
        }
        runtime.phase = 'settling'
        try {
            this.captureUsage(id, runtime)
            this.captureRecentTurns(id, runtime)
            const interrupted =
                runtime.interruptRequested || isAbortError(error)
            if (interrupted) {
                this.setRecord(id, (previous) => ({
                    ...previous,
                    status: AgentStatus.interrupted(),
                }))
            } else if (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                const status = AgentStatus.errored(message)
                this.setRecord(id, (previous) => ({ ...previous, status }))
                await this.safeDeliverCompletion(record, sequence, status)
            } else {
                const status = AgentStatus.completed(
                    runtime.session.getLastAssistantText() ?? null
                )
                this.setRecord(id, (previous) => ({
                    ...previous,
                    status,
                    lastResult:
                        status._tag === 'Completed'
                            ? (status.message ?? undefined)
                            : undefined,
                    activeTools: runtime.session.getActiveToolNames(),
                    thinkingLevel: runtime.session.thinkingLevel,
                }))
                await this.safeDeliverCompletion(record, sequence, status)
            }
        } finally {
            permit.release()
            runtime.activePermitSequence = undefined
            runtime.currentRun = undefined
            runtime.phase = 'idle'
            runtime.interruptRequested = false
            runtime.lastTouched = Date.now()
            this.emit({
                _tag: 'ActivityCompleted',
                agentId: id,
                agentPath: record.path,
                parentTurnId: record.initiatingTurnId as never,
            })
        }
    }

    private captureUsage(id: AgentId, runtime: AgentRuntime): void {
        try {
            const stats = runtime.session.getSessionStats()
            const model = runtime.session.model
            const usage: AgentUsageTotals = {
                provider: model?.provider ?? 'unknown',
                modelId: model?.id ?? 'unknown',
                input: stats.tokens.input,
                output: stats.tokens.output,
                cacheRead: stats.tokens.cacheRead,
                cacheWrite: stats.tokens.cacheWrite,
                cost: stats.cost,
                userMessages: stats.userMessages,
                assistantMessages: stats.assistantMessages,
                toolResults: stats.toolResults,
                toolCalls: [],
            }
            this.setRecord(id, (previous) => ({ ...previous, usage }))
        } catch {
            // Diagnostics must never affect run settlement.
        }
    }

    private async safeDeliverCompletion(
        record: AgentRecord,
        sequence: number,
        status: AgentRecord['status']
    ): Promise<void> {
        try {
            await this.deliverCompletion(record, sequence, status)
        } catch {
            // A parent may be shutting down; the child run still settles.
        }
    }

    private async deliverCompletion(
        record: AgentRecord,
        sequence: number,
        status: AgentRecord['status']
    ): Promise<void> {
        if (
            record.lastDeliveredRunSequence !== undefined &&
            record.lastDeliveredRunSequence >= sequence
        )
            return
        const payload = formatFinalAnswer(status)
        if (payload === null || !record.parentPath) return
        const parent = this.getRecordByPath(record.parentPath)
        if (!parent) return
        const comm = finalAnswerCommunication({
            author: record.path,
            recipient: record.parentPath,
            payload,
        })
        const endpoint = await this.endpointFor(parent.id)
        await endpoint.send(comm, { triggerTurn: false })
        this.setRecord(record.id, (previous) => ({
            ...previous,
            lastDeliveredRunSequence: sequence,
        }))
        this.waitHub.notifyMailbox(parent.path as string)
    }

    private async endpointFor(id: AgentId): Promise<CommunicationEndpoint> {
        if (id === this.rootId) return this.options.rootEndpoint
        const runtime = await this.ensureLoaded(id)
        return runtime.endpoint!
    }

    private ensureLoaded(id: AgentId): Promise<AgentRuntime> {
        const existing = this.runtimes.get(id)
        if (existing) return Promise.resolve(existing)
        const pending = this.loading.get(id)
        if (pending) return pending
        const record = this.records.get(id)
        if (!record) return Promise.reject(new AgentNotFoundError(String(id)))

        const load = this.loadRuntime(id, record)
        this.trackLoading(id, load)
        return load
    }

    private trackLoading(id: AgentId, load: Promise<AgentRuntime>): void {
        this.loading.set(id, load)
        load.then(
            () => {
                if (this.loading.get(id) === load) this.loading.delete(id)
            },
            () => {
                if (this.loading.get(id) === load) this.loading.delete(id)
            }
        )
    }

    private async loadRuntime(
        id: AgentId,
        record: AgentRecord
    ): Promise<AgentRuntime> {
        this.setRecord(id, (previous) => ({
            ...previous,
            residency: 'loading',
        }))
        try {
            return await this.residencyMutex.runExclusive(async () => {
                const existing = this.runtimes.get(id)
                if (existing) return existing
                await this.evictOneIfRequired(id)
                const runtime = await this.factory.open(record)
                return await this.registerRuntime(record, runtime)
            })
        } catch (error) {
            this.setRecord(id, (previous) => ({
                ...previous,
                residency: 'unloaded',
            }))
            throw new AgentLoadFailedError(
                record.path as string,
                error instanceof Error ? error.message : String(error)
            )
        }
    }

    private async initializeSpawnRuntime(
        record: AgentRecord,
        parentSnapshot: ParentExecutionSnapshot,
        fork: ForkTurns
    ): Promise<AgentRuntime> {
        return await this.residencyMutex.runExclusive(async () => {
            await this.evictOneIfRequired(record.id)
            const runtime = await this.factory.create(
                record,
                parentSnapshot,
                fork
            )
            return await this.registerRuntime(record, runtime)
        })
    }

    private async registerRuntime(
        record: AgentRecord,
        runtime: AgentRuntime
    ): Promise<AgentRuntime> {
        if (this.shutdownFlag) {
            await runtime.dispose()
            throw new Error('session is shutting down')
        }
        runtime.endpoint = childEndpoint(record.path, runtime.session)
        this.runtimes.set(record.id, runtime)
        this.sessionBindings.set(runtime.session.sessionId, record.id)
        this.setRecord(record.id, (previous) => ({
            ...previous,
            residency: 'loaded',
            sessionId: runtime.session.sessionId,
            sessionFile: runtime.session.sessionFile,
            persistedSessionId: runtime.session.sessionId,
            activeTools: runtime.session.getActiveToolNames(),
            thinkingLevel: runtime.session.thinkingLevel,
        }))
        this.captureRecentTurns(record.id, runtime)
        this.emit({
            _tag: 'ResidencyChanged',
            agentId: record.id,
            residency: 'loaded',
        })
        return runtime
    }

    private async snapshotFor(
        record: AgentRecord
    ): Promise<ParentExecutionSnapshot> {
        if (record.path === ROOT_PATH) return this.options.getRootSnapshot()
        const runtime = await this.ensureLoaded(record.id)
        return {
            path: record.path,
            cwd: runtime.session.sessionManager.getCwd(),
            model: {
                provider:
                    runtime.session.model?.provider ??
                    parseModel(record.model).provider,
                id: runtime.session.model?.id ?? parseModel(record.model).id,
            },
            thinkingLevel: runtime.session.thinkingLevel,
            activeTools: runtime.session.getActiveToolNames(),
            contextEntries:
                runtime.session.sessionManager.buildContextEntries(),
            sessionFile: runtime.session.sessionFile,
            sessionId: runtime.session.sessionId,
        }
    }

    private async evictOneIfRequired(exceptId: AgentId): Promise<void> {
        if (this.runtimes.size < this.options.config.maxLoadedAgents) return
        const candidates = [...this.records.values()]
            .filter((record) => record.id !== exceptId)
            .filter((record) => record.path !== ROOT_PATH)
            .filter((record) => {
                const runtime = this.runtimes.get(record.id)
                return Boolean(
                    runtime &&
                    !runtime.session.isStreaming &&
                    !runtime.currentRun &&
                    record.status._tag !== 'PendingInit' &&
                    record.status._tag !== 'Running'
                )
            })
            .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
        const victim = candidates[0]
        if (!victim) {
            throw new Error(
                `No idle runtime can be evicted at maxLoadedAgents=${this.options.config.maxLoadedAgents}.`
            )
        }
        const runtime = this.runtimes.get(victim.id)
        if (!runtime) return
        this.captureRecentTurns(victim.id, runtime)
        await runtime.dispose()
        this.runtimes.delete(victim.id)
        this.setRecord(victim.id, (previous) => ({
            ...previous,
            residency: 'unloaded',
        }))
        this.emit({
            _tag: 'ResidencyChanged',
            agentId: victim.id,
            residency: 'unloaded',
        })
    }

    private assertSpawnReservationAvailable(childPath: AgentPath): void {
        if (this.pathIndex.has(childPath as string)) {
            throw new AgentAlreadyExistsError(childPath as string)
        }
        if (this.childDepth(childPath) > this.maxDepth()) {
            throw new AgentSpawnFailedError('Agent depth limit reached.')
        }
        const childCount = this.records.size - 1
        if (childCount >= this.options.config.maxAgents) {
            throw new AgentCapacityReachedError(
                this.options.config.maxAgents,
                childCount
            )
        }
    }

    private captureRecentTurns(id: AgentId, runtime: AgentRuntime): void {
        const turns = runtime.session.messages
            .map(toTurnPreview)
            .filter((turn): turn is AgentTurnPreview => turn !== null)
            .slice(-10)
        this.recentTurns.set(id, turns)
    }

    private mutex(id: AgentId): AgentMutex {
        let mutex = this.mutexes.get(id)
        if (!mutex) {
            mutex = new AgentMutex()
            this.mutexes.set(id, mutex)
        }
        return mutex
    }

    private setRecord(
        id: AgentId,
        update: (record: AgentRecord) => AgentRecord
    ): void {
        const previous = this.records.get(id)
        if (!previous) return
        const next = {
            ...update(previous),
            lastActivityAt: Date.now(),
        }
        this.records.set(id, next)
        if (previous.status._tag !== next.status._tag) {
            this.emit({
                _tag: 'StatusChanged',
                agentId: id,
                previous: previous.status,
                current: next.status,
            })
        }
    }

    private touch(id: AgentId): void {
        const record = this.records.get(id)
        if (record)
            this.records.set(id, { ...record, lastActivityAt: Date.now() })
    }

    private childDepth(path: AgentPath): number {
        return (path as string).split('/').filter(Boolean).length - 2
    }

    private maxDepth(): number {
        return this.options.config.maxDepth
    }
}

function toTurnPreview(message: unknown): AgentTurnPreview | null {
    if (!message || typeof message !== 'object') return null
    const candidate = message as {
        role?: unknown
        content?: unknown
    }
    if (
        candidate.role !== 'user' &&
        candidate.role !== 'assistant' &&
        candidate.role !== 'custom'
    ) {
        return null
    }
    const text = extractMessageText(candidate.content)
    if (!text) return null
    return {
        role: candidate.role === 'custom' ? 'message' : candidate.role,
        text,
    }
}

function extractMessageText(content: unknown): string {
    if (typeof content === 'string') return normalizePreviewText(content)
    if (!Array.isArray(content)) return ''
    return normalizePreviewText(
        content
            .map((part) => {
                if (!part || typeof part !== 'object') return ''
                const value = part as { type?: unknown; text?: unknown }
                return value.type === 'text' && typeof value.text === 'string'
                    ? value.text
                    : ''
            })
            .filter(Boolean)
            .join(' ')
    )
}

function normalizePreviewText(value: string): string {
    return value.trim().replace(/\s+/g, ' ')
}

function safeRootSnapshot(
    getSnapshot: () => ParentExecutionSnapshot
): ParentExecutionSnapshot | undefined {
    try {
        return getSnapshot()
    } catch {
        return undefined
    }
}

function formatModel(model: { provider: string; id: string }): string {
    return `${model.provider}/${model.id}`
}

function parseModel(value: string): { provider: string; id: string } {
    const separator = value.indexOf('/')
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid model identity "${value}".`)
    }
    return {
        provider: value.slice(0, separator),
        id: value.slice(separator + 1),
    }
}

function terminalMessage(record: AgentRecord): string | undefined {
    if (record.status._tag === 'Completed')
        return record.status.message ?? undefined
    if (record.status._tag === 'Errored') return record.status.error
    return undefined
}

function restoredStatus(tag: string, message?: string): AgentStatus {
    switch (tag) {
        case 'Completed':
            return AgentStatus.completed(message ?? null)
        case 'Errored':
            return AgentStatus.errored(message ?? 'unknown error')
        case 'Interrupted':
        case 'Running':
            return AgentStatus.interrupted()
        default:
            return AgentStatus.pendingInit()
    }
}

function parseThinkingLevel(
    value: string | undefined
): ThinkingLevel | undefined {
    if (value === undefined) return undefined
    const levels: readonly ThinkingLevel[] = [
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
    ]
    if (levels.includes(value as ThinkingLevel)) {
        return value as ThinkingLevel
    }
    throw new InvalidModelOverrideError(`invalid reasoning_effort "${value}"`)
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && /abort/i.test(error.message)
}

function withNote(message: string, note: string | null): string {
    return note ? `${message} ${note}` : message
}
