import {
    createModelPricingResolver,
    parseSessionUsage,
    type ModelPricingResolver,
} from '../../../shared/usage.ts'
import type { PromptTokens } from '../../../shared/dashboard-state.ts'
import {
    InvalidTaskNameError,
    isRootPath,
    isValidTaskName,
    joinAgentPath,
    pathMatchesPrefix,
    resolveTarget,
    ROOT_PATH,
} from '../domain/agent-path.ts'
import { AgentStatus, type AgentResidency } from '../domain/agent-status.ts'
import { ActivityFeed } from '../ui/activity-feed.ts'
import type { ThinkingLevel, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
    AgentLimitReached,
    AgentRecord,
    AgentUsageTotals,
    PendingCompletion,
} from '../domain/agent-record.ts'
import {
    assertNonEmptyMessage,
    newTaskCommunication,
    plainMessageCommunication,
    parseForkTurns,
    type FinalAnswerMeta,
    type ForkTurns,
    type InterAgentCommunication,
} from '../domain/communication.ts'
import { formatCompletionResult } from '../domain/completion.ts'
import {
    AgentAlreadyExistsError,
    AgentBlockedError,
    AgentCapacityReachedError,
    AgentLoadFailedError,
    AgentNotFoundError,
    AgentSpawnFailedError,
    InvalidModelOverrideError,
    ModelRequestLimitError,
    RunDeadlineExceededError,
    TokenBudgetExhaustedError,
    RootFollowupForbiddenError,
    SelfInterruptForbiddenError,
} from '../domain/errors.ts'
import {
    newAgentId,
    newCommunicationId,
    newTurnId,
    type AgentId,
    type AgentPath,
    type ToolCallId,
} from '../domain/ids.ts'
import type { ParentExecutionSnapshot } from '../domain/parent-snapshot.ts'
import { resolveRole, resolveRoleTools } from '../config/roles.ts'
import { AgentMutex, type AgentRuntime } from './agent-runtime.ts'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { ExecutionLimiter, type ExecutionPermit } from './execution-limiter.ts'
import {
    childEndpoint,
    type CommunicationEndpoint,
    type InsertionState,
    sessionInsertionProbe,
    SUBAGENTS_COMMUNICATION_CUSTOM_TYPE,
} from './transport.ts'
import {
    SessionFactory,
    type SubagentSessionFactory,
} from './session-factory.ts'
import { WaitHub } from './wait-hub.ts'
import { resolveLimits, TokenBudget, type ResolvedLimits } from './limits.ts'
import {
    clampWaitTimeout,
    type CodexSubagentsConfig,
} from '../config/config.ts'
import type {
    DeliveryCheckpointEvent,
    DeliveryCheckpointListener,
    SubagentEvent,
    SubagentLimitsSnapshot,
} from '../domain/events.ts'
import type { PersistedSubagentStateV2 } from '../persistence/schema.ts'
import { SUBAGENT_META_CUSTOM_TYPE } from '../persistence/session-state.ts'
import {
    restoreAgentRecords,
    serializeAgentRecords,
} from '../persistence/record-snapshot.ts'

export interface ListedAgent {
    readonly path: AgentPath
    readonly status: AgentRecord['status']['_tag']
    readonly residency: AgentResidency
    readonly role?: string
    readonly model: string
    readonly parentPath: AgentPath | null
    /** Stable blocked reason when a cold reopen failed. */
    readonly blockedReason?: string
    /** Undelivered completion intent in the outbox for this agent. */
    readonly hasPendingMail: boolean
    /** WaitHub activity observed for this agent. */
    readonly hasPendingActivity: boolean
    readonly running: boolean
    /** Blocked in `wait_agent` right now. */
    readonly waiting: boolean
}

type TimerHandle = ReturnType<typeof setTimeout> | number

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

export type WaitWakeReason = 'mailbox' | 'steer' | 'timeout'

export interface WaitResult {
    readonly message: string
    readonly timedOut: boolean
    readonly wakeReason: WaitWakeReason
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
    /** Live check used to route root-bound messages (steer vs append). */
    readonly isRootStreaming?: () => boolean
    /** Enable durable insertion probes and checkpoints. Root integration sets this. */
    readonly deliveryReceipts?: boolean
    /** Child resource-loader warnings and extension errors. */
    readonly onLoaderDiagnostics?: (diagnostics: readonly string[]) => void
    /** Test seam for deterministic run deadlines. */
    readonly setTimer?: (callback: () => void, timeoutMs: number) => TimerHandle
    readonly clearTimer?: (handle: TimerHandle) => void
}

interface TrackedRun {
    readonly runtime: AgentRuntime
    readonly sequence: number
    readonly permit?: ExecutionPermit
    nativeStarted: boolean
    settled: boolean
    modelRequests: number
    limitReached?: AgentLimitReached
    finish(error?: unknown): void
}

interface OutstandingDispatch {
    readonly communicationId: string
    readonly childId: AgentId
    readonly recipient: AgentPath
    readonly runSequence: number
    readonly epochAtDispatch: number
    failed: boolean
}

interface DeliveryDispatchReceipt {
    readonly childId: AgentId
    readonly sequence: number
    readonly communicationId: string
    readonly recipient: AgentPath
}

interface RuntimeLease {
    readonly runtime: AgentRuntime
    release(): void
}

export interface ReconcileDeliveryOptions {
    /** Treat this call as a native terminal boundary for the recipient. */
    readonly terminal?: boolean
    /** Explicit override after the host confirms the recipient is idle. */
    readonly forceRetry?: boolean
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
    private readonly resolvedLimits: ResolvedLimits
    private readonly budget: TokenBudget
    private readonly nativeRuns = new Map<AgentId, TrackedRun>()
    private readonly observedRuntimes = new WeakSet<AgentRuntime>()
    private readonly factory: SubagentSessionFactory
    private readonly rootId: AgentId
    private shutdownFlag = false
    private readonly completionDeliveries = new Map<string, Promise<void>>()
    private completionDrain?: Promise<void>
    private completionDrainRequested = false
    private readonly deliveryCheckpointListeners =
        new Set<DeliveryCheckpointListener>()
    private readonly outstandingDispatches = new Map<
        string,
        OutstandingDispatch
    >()
    /** Intents created in this process but not yet checkpointed. */
    private readonly unconfirmedIntents = new Set<string>()
    private readonly deliveryEpochs = new Map<string, number>()
    private readonly runtimePins = new Map<AgentId, number>()
    private readonly residencyWaiters = new Set<() => void>()
    private residencyGeneration = 0
    private readonly ackMutexes = new Map<AgentId, AgentMutex>()
    private readonly deliveryOperations = new Set<Promise<unknown>>()
    private readonly deliveryRetryTimers = new Set<
        ReturnType<typeof setTimeout>
    >()
    private readonly deadlineTimers = new Map<
        AgentId,
        {
            readonly sequence: number
            readonly handle: TimerHandle
        }
    >()
    private deliveryGeneration = 0
    private deliveryDetached = false
    private shutdownPromise?: Promise<void>

    constructor(options: SubagentCoordinatorOptions) {
        this.options = options
        this.limiter = new ExecutionLimiter(
            options.config.maxConcurrentExecutions
        )
        this.resolvedLimits = resolveLimits(options.config)
        this.budget = new TokenBudget(
            this.resolvedLimits.maxTreeTokens,
            this.resolvedLimits.warnAtRatio
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
                onLoaderDiagnostics: options.onLoaderDiagnostics,
                onRuntimeCreated: (record, runtime) =>
                    this.observeRuntime(record, runtime),
                onActivity: (path, activity) => {
                    const record = this.getRecordByPath(path)
                    if (!record) return
                    this.touch(record.id)
                    if (activity.action === 'commit') {
                        this.activityFeed.commitLive(path as string)
                    } else if (
                        activity.action === 'update' &&
                        (activity.kind === 'thinking' ||
                            activity.kind === 'message')
                    ) {
                        this.activityFeed.updateLive(
                            path as string,
                            activity.kind,
                            activity.summary ?? ''
                        )
                    } else if (activity.kind && activity.summary) {
                        this.activityFeed.push(
                            path as string,
                            activity.kind,
                            activity.summary,
                            {
                                toolCallId: activity.toolCallId,
                                nested: activity.nested,
                            }
                        )
                    }
                    this.emit({
                        _tag: 'ToolActivity',
                        agentId: record.id,
                        summary: activity.summary ?? activity.action,
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

    /**
     * Awaitable delivery checkpoint. Unlike `emit`, listener failures are
     * propagated so a caller cannot send or acknowledge after the durable
     * checkpoint failed.
     */
    onDeliveryCheckpoint(listener: DeliveryCheckpointListener): () => void {
        this.deliveryCheckpointListeners.add(listener)
        return () => this.deliveryCheckpointListeners.delete(listener)
    }

    detachDelivery(): void {
        if (this.deliveryDetached) return
        this.deliveryDetached = true
        this.deliveryGeneration += 1
        this.completionDrainRequested = false
        this.outstandingDispatches.clear()
        for (const timer of this.deliveryRetryTimers) clearTimeout(timer)
        this.deliveryRetryTimers.clear()
        this.clearAllDeadlines()
    }

    private get receiptsEnabled(): boolean {
        return this.options.deliveryReceipts === true
    }

    private async checkpointDelivery(
        reason: DeliveryCheckpointEvent['reason'],
        childId: AgentId,
        recipient: AgentPath,
        runSequence: number,
        communicationId: string
    ): Promise<void> {
        if (!this.receiptsEnabled) return
        if (this.deliveryCheckpointListeners.size === 0) {
            throw new Error(
                'Delivery receipts are enabled but no checkpoint listener is attached.'
            )
        }
        const event: DeliveryCheckpointEvent = {
            _tag: 'DeliveryCheckpoint',
            reason,
            communicationId,
            agentId: childId,
            recipient,
            runSequence,
        }
        await Promise.all(
            [...this.deliveryCheckpointListeners].map((listener) =>
                Promise.resolve(listener(event))
            )
        )
    }

    private trackDeliveryOperation<T>(operation: Promise<T>): Promise<T> {
        this.deliveryOperations.add(operation)
        const clear = () => {
            this.deliveryOperations.delete(operation)
        }
        void operation.then(clear, clear)
        return operation
    }

    getConfig(): CodexSubagentsConfig {
        return this.options.config
    }

    /** Visible run limits plus shared tree token accounting. */
    limits(): SubagentLimitsSnapshot {
        return {
            ...this.budget.snapshot(),
            ...(this.resolvedLimits.runDeadlineMs !== undefined
                ? { runDeadlineMs: this.resolvedLimits.runDeadlineMs }
                : {}),
            ...(this.resolvedLimits.maxModelRequestsPerRun !== undefined
                ? {
                      maxModelRequestsPerRun:
                          this.resolvedLimits.maxModelRequestsPerRun,
                  }
                : {}),
            warnAtRatio: this.resolvedLimits.warnAtRatio,
            unlimited: this.resolvedLimits.unlimited,
        }
    }

    private emitLimitsChanged(): void {
        this.emit({ _tag: 'LimitsChanged', limits: this.limits() })
    }

    private checkLimitAdmission(): void {
        this.emitLimitsChanged()
        this.budget.checkAdmission()
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
        const record = id ? this.records.get(id) : undefined
        if (!record) {
            throw new AgentNotFoundError(`session:${sessionId}`)
        }
        return record.path
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
                    ...(record.blocked
                        ? { blockedReason: record.blocked.reason }
                        : {}),
                    hasPendingMail: this.hasUndeliveredCompletion(record.path),
                    hasPendingActivity: this.waitHub.hasPending(
                        record.path as string
                    ),
                    running: runtime?.session.isStreaming ?? false,
                    waiting: this.waitHub.isWaiting(record.path as string),
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
        this.checkLimitAdmission()
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
            activeTools: resolveRoleTools(parentSnapshot.activeTools, role)
                .tools,
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
            task: options.message,
        }
        let initialization!: Promise<AgentRuntime>
        let spawnPermit: ExecutionPermit | undefined
        await this.registryMutex.runExclusive(async () => {
            this.assertSpawnReservationAvailable(childPath)
            // Reserve execution admission before creating a child session or
            // running its extension startup. A rejection must not leave side
            // effects or a loaded session behind.
            spawnPermit = this.limiter.tryAcquire()
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
            await this.startRun(record.id, comm, spawnPermit)
            spawnPermit = undefined
            this.emit({
                _tag: 'ActivityStarted',
                callId: options.callId ?? (`spawn-${Date.now()}` as ToolCallId),
                agentId: record.id,
                agentPath: childPath,
                parentTurnId: record.initiatingTurnId as never,
            })
            return { path: childPath, id: record.id }
        } catch (error) {
            spawnPermit?.release()
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
        const root = target.path === ROOT_PATH || target.id === this.rootId
        const lease = root ? undefined : await this.leaseRuntime(target.id)
        const endpoint = root
            ? this.options.rootEndpoint
            : lease!.runtime.endpoint!
        const comm = plainMessageCommunication({
            author: args.caller,
            recipient: target.path,
            payload: args.message,
            sourceCallId: args.callId,
        })
        try {
            await this.mutex(target.id).runExclusive(async () => {
                const streaming = root
                    ? (this.options.isRootStreaming?.() ?? false)
                    : lease!.runtime.session.isStreaming
                await endpoint.send(
                    comm,
                    streaming
                        ? { triggerTurn: true, delivery: 'steer' }
                        : { triggerTurn: false }
                )
            })
        } finally {
            lease?.release()
        }
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
        this.checkLimitAdmission()
        const lease = await this.leaseRuntime(target.id)
        const runtime = lease.runtime
        const comm = newTaskCommunication({
            kind: 'followup',
            author: args.caller,
            recipient: target.path,
            payload: args.message,
            sourceCallId: args.callId,
        })
        try {
            await this.mutex(target.id).runExclusive(async () => {
                if (runtime.session.isStreaming) {
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
        } finally {
            lease.release()
        }
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
        const lease = this.leaseExistingRuntime(target.id)
        const runtime = lease?.runtime
        if (!runtime?.session.isStreaming && !runtime?.currentRun) {
            lease?.release()
            return target.status
        }
        try {
            runtime.interruptRequested = true
            await runtime.session.abort().catch(() => undefined)
            await runtime.currentRun?.catch(() => undefined)
        } finally {
            lease?.release()
        }
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
        signal?: AbortSignal
    }): Promise<WaitResult> {
        const caller = this.getRecordByPath(args.caller)
        if (!caller) throw new AgentNotFoundError(args.caller as string)
        const clamped = clampWaitTimeout(this.options.config, args.timeoutMs)
        if (clamped.rejected) throw new Error(clamped.rejected)
        const outcome = await this.waitHub.wait(
            caller.path as string,
            clamped.effectiveMs,
            args.signal
        )
        if (outcome.timedOut) {
            return {
                message: withNote(WAIT_TIMED_OUT, clamped.note),
                timedOut: true,
                wakeReason: 'timeout',
            }
        }
        return {
            message: withNote(
                outcome.kind === 'steer' ? WAIT_INTERRUPTED : WAIT_COMPLETED,
                clamped.note
            ),
            timedOut: false,
            wakeReason: outcome.kind,
        }
    }

    notifySteer(path: AgentPath): void {
        this.waitHub.notifySteer(path as string)
    }

    shutdown(): Promise<void> {
        return (this.shutdownPromise ??= this.runShutdown())
    }

    private async runShutdown(): Promise<void> {
        const failures: unknown[] = []
        try {
            this.detachDelivery()
            this.shutdownFlag = true
            this.notifyResidencyChange()
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
            while (this.deliveryOperations.size > 0) {
                await Promise.allSettled([...this.deliveryOperations])
            }
            const disposals = await Promise.allSettled(
                runtimes.map(async (runtime) => await runtime.dispose())
            )
            for (const result of disposals) {
                if (result.status === 'rejected') failures.push(result.reason)
            }
        } finally {
            this.clearAllDeadlines()
            this.runtimes.clear()
            this.loading.clear()
            this.waitHub.clear()
            this.activityFeed.clear()
            this.notifyResidencyChange()
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                `subagent shutdown failed for ${failures.length} runtimes`
            )
        }
    }

    serialize(rootSessionId: string): PersistedSubagentStateV2 {
        return serializeAgentRecords(this.records.values(), rootSessionId)
    }

    /**
     * Cumulative child billing, excluding the parent. Costs already carry
     * catalog pricing for children whose provider reported none.
     */
    usageTotals(): PromptTokens & { cost: number } {
        const totals = { cost: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
        for (const record of this.records.values()) {
            const usage = record.usage
            if (!usage) continue
            totals.cost += usage.cost
            totals.input += usage.input
            totals.cacheRead += usage.cacheRead
            totals.cacheWrite += usage.cacheWrite
        }
        return totals
    }

    restore(state: unknown): void {
        let added = false
        for (const record of restoreAgentRecords(
            state,
            this.options.rootSessionId()
        )) {
            if (this.records.has(record.id) || this.pathIndex.has(record.path))
                continue
            this.records.set(record.id, record)
            this.pathIndex.set(record.path, record.id)
            const tokens = usageTokens(record.usage)
            if (tokens > 0) this.budget.record(tokens)
            added = true
        }
        if (added) this.emitLimitsChanged()
    }

    private async startRun(
        id: AgentId,
        comm: InterAgentCommunication,
        permit?: ExecutionPermit,
        receipt?: DeliveryDispatchReceipt
    ): Promise<void> {
        if (this.shutdownFlag) throw new Error('session is shutting down')
        const runtime = this.runtimes.get(id)
        if (!this.records.has(id) || !runtime)
            throw new AgentNotFoundError(String(id))
        if (runtime.session.isStreaming && !runtime.interruptRequested) {
            permit?.release()
            if (receipt) {
                if (this.deliveryDetached) return
                this.markOutstanding(
                    receipt.childId,
                    receipt.sequence,
                    receipt.communicationId,
                    receipt.recipient
                )
            }
            try {
                await runtime.endpoint!.send(comm, {
                    triggerTurn: true,
                    delivery: 'steer',
                })
            } catch (error) {
                if (receipt) this.failOutstanding(receipt.communicationId)
                throw error
            }
            this.waitHub.notifySteer(runtime.path)
            return
        }
        if (runtime.currentRun) await runtime.currentRun
        // Notification handlers may have deferred another native turn.
        if (runtime.session.isIdle === false)
            await runtime.session.waitForIdle()
        if (this.shutdownFlag) throw new Error('session is shutting down')
        if (runtime.session.isStreaming) {
            permit?.release()
            if (receipt) {
                if (this.deliveryDetached) return
                this.markOutstanding(
                    receipt.childId,
                    receipt.sequence,
                    receipt.communicationId,
                    receipt.recipient
                )
            }
            try {
                await runtime.endpoint!.send(comm, {
                    triggerTurn: true,
                    delivery: 'steer',
                })
            } catch (error) {
                if (receipt) this.failOutstanding(receipt.communicationId)
                throw error
            }
            this.waitHub.notifySteer(runtime.path)
            return
        }
        const run = this.beginRun(
            id,
            runtime,
            permit ?? this.limiter.tryAcquire()
        )
        if (receipt) {
            if (this.deliveryDetached) {
                run.finish()
                return
            }
            this.markOutstanding(
                receipt.childId,
                receipt.sequence,
                receipt.communicationId,
                receipt.recipient
            )
        }
        try {
            void runtime.endpoint!.send(comm, { triggerTurn: true }).then(
                () => {
                    // Real SDK runs settle through agent_settled. Preflight-only
                    // sends and non-event adapters still need promise settlement.
                    if (!run.nativeStarted) run.finish()
                },
                (error) => {
                    if (receipt) this.failOutstanding(receipt.communicationId)
                    run.finish(error)
                }
            )
        } catch (error) {
            if (receipt) this.failOutstanding(receipt.communicationId)
            run.finish(error)
            throw error
        }
    }

    private beginRun(
        id: AgentId,
        runtime: AgentRuntime,
        permit?: ExecutionPermit
    ): TrackedRun {
        runtime.runSequence += 1
        runtime.activePermitSequence = permit?.sequence
        runtime.interruptRequested = false
        runtime.lastAssistant = undefined
        runtime.phase = 'running'
        this.setRecord(id, (previous) => ({
            ...previous,
            status: AgentStatus.running(),
            runSequence: runtime.runSequence,
            runStartedAt: Date.now(),
            limitReached: undefined,
            blocked: undefined,
        }))
        let resolveRun!: () => void
        let rejectRun!: (error: unknown) => void
        const completion = new Promise<void>((resolve, reject) => {
            resolveRun = resolve
            rejectRun = reject
        })
        // Runs are asynchronous; callers may inspect them without awaiting.
        void completion.catch(() => undefined)
        const run: TrackedRun = {
            runtime,
            sequence: runtime.runSequence,
            permit,
            nativeStarted: false,
            settled: false,
            modelRequests: 0,
            finish: (error) => {
                if (run.settled) return
                run.settled = true
                void this.settleRun(
                    id,
                    runtime,
                    run.sequence,
                    error,
                    permit,
                    run.limitReached
                ).then(resolveRun, rejectRun)
            },
        }
        this.nativeRuns.set(id, run)
        runtime.currentRun = completion
        this.armDeadline(id, runtime, run.sequence)
        return run
    }

    private armDeadline(
        id: AgentId,
        runtime: AgentRuntime,
        sequence: number
    ): void {
        const deadlineMs = this.resolvedLimits.runDeadlineMs
        if (deadlineMs === undefined) return
        const clearTimer = this.options.clearTimer ?? clearTimeout
        const previous = this.deadlineTimers.get(id)
        if (previous) clearTimer(previous.handle)
        const setTimer = this.options.setTimer ?? setTimeout
        const handle = setTimer(() => {
            const run = this.nativeRuns.get(id)
            if (
                !run ||
                run.runtime !== runtime ||
                run.sequence !== sequence ||
                run.settled ||
                run.limitReached
            ) {
                return
            }
            const error = new RunDeadlineExceededError(deadlineMs)
            run.limitReached = { kind: 'deadline', detail: error.message }
            void runtime.session.abort().catch(() => undefined)
        }, deadlineMs)
        if (typeof handle !== 'number') handle.unref?.()
        this.deadlineTimers.set(id, { sequence, handle })
    }

    private clearDeadline(id: AgentId, sequence?: number): void {
        const timer = this.deadlineTimers.get(id)
        if (!timer) return
        if (sequence !== undefined && timer.sequence !== sequence) return
        ;(this.options.clearTimer ?? clearTimeout)(timer.handle)
        this.deadlineTimers.delete(id)
    }

    private clearAllDeadlines(): void {
        for (const timer of this.deadlineTimers.values()) {
            ;(this.options.clearTimer ?? clearTimeout)(timer.handle)
        }
        this.deadlineTimers.clear()
    }

    /** Observe extension-driven turns as well as coordinator-driven turns. */
    private observeRuntime(record: AgentRecord, runtime: AgentRuntime): void {
        if (this.observedRuntimes.has(runtime)) return
        this.observedRuntimes.add(runtime)
        const unsubscribe = runtime.session.subscribe((event) => {
            if (event.type === 'agent_start') {
                let run = this.nativeRuns.get(record.id)
                if (!run || run.runtime !== runtime || run.settled) {
                    let permit: ExecutionPermit | undefined
                    if (!this.shutdownFlag) {
                        try {
                            permit = this.limiter.tryAcquire()
                        } catch {
                            // Extension sends bypass admission. Stop an excess
                            // turn using the SDK's already-created abort signal.
                        }
                    }
                    run = this.beginRun(record.id, runtime, permit)
                    if (!permit) {
                        runtime.interruptRequested = true
                        void runtime.session.abort().catch(() => undefined)
                    }
                }
                run.nativeStarted = true
            } else if (
                event.type === 'message_end' &&
                (event.message.role === 'assistant' ||
                    event.message.role === 'toolResult')
            ) {
                // Public message_end precedes SDK persistence, so include its finalized message once.
                this.captureUsage(record.id, runtime, event.message)
            } else if (
                event.type === 'message_end' &&
                event.message.role === 'custom' &&
                (event.message as { customType?: unknown }).customType ===
                    SUBAGENTS_COMMUNICATION_CUSTOM_TYPE
            ) {
                if (this.receiptsEnabled) {
                    void this.reconcileDeliveryReceipts(record.path).catch(
                        () => undefined
                    )
                }
            } else if (event.type === 'turn_start') {
                const run = this.nativeRuns.get(record.id)
                if (!run || run.runtime !== runtime || run.settled) return
                run.modelRequests += 1
                const limit = this.resolvedLimits.maxModelRequestsPerRun
                if (limit === undefined || run.modelRequests <= limit) return
                if (run.limitReached) {
                    // A provider that ignored the first abort still gets a
                    // repeated idempotent nudge on later turns.
                    void runtime.session.abort().catch(() => undefined)
                    return
                }
                // Pi compaction does not emit turn_start, so compaction work is
                // not counted by maxModelRequestsPerRun.
                const error = new ModelRequestLimitError(
                    limit,
                    run.modelRequests
                )
                run.limitReached = {
                    kind: 'requests',
                    detail: error.message,
                }
                void runtime.session.abort().catch(() => undefined)
            } else if (
                event.type === 'turn_end' ||
                event.type === 'compaction_end' ||
                (event.type === 'entry_appended' &&
                    event.entry.type === 'usage')
            ) {
                this.captureUsage(record.id, runtime)
            } else if (event.type === 'agent_settled') {
                const run = this.nativeRuns.get(record.id)
                if (run?.runtime === runtime) run.finish()
                if (this.receiptsEnabled) {
                    const generation = this.deliveryGeneration
                    void this.reconcileDeliveryReceipts(record.path).catch(
                        () => undefined
                    )
                    const pendingAtSettlement = this.hasPendingFor(record.path)
                    if (!pendingAtSettlement) return
                    // Native settlement precedes deferred turn processing. A
                    // next-tick idle check is the first safe retry boundary.
                    const timer = setTimeout(() => {
                        this.deliveryRetryTimers.delete(timer)
                        if (
                            this.deliveryDetached ||
                            this.deliveryGeneration !== generation ||
                            !runtime.session.isIdle
                        ) {
                            return
                        }
                        void this.reconcileDeliveryReceipts(record.path, {
                            forceRetry: true,
                        }).catch(() => undefined)
                    }, 0)
                    timer.unref?.()
                    this.deliveryRetryTimers.add(timer)
                }
            }
        })
        const dispose = runtime.dispose.bind(runtime)
        runtime.dispose = async () => {
            try {
                await dispose()
            } finally {
                unsubscribe()
                const run = this.nativeRuns.get(record.id)
                if (run?.runtime === runtime) {
                    this.clearDeadline(record.id, run.sequence)
                    run.permit?.release()
                    this.nativeRuns.delete(record.id)
                }
            }
        }
        // A custom factory may have emitted startup before returning its runtime.
        if (runtime.session.isStreaming && !this.nativeRuns.has(record.id)) {
            const run = this.beginRun(record.id, runtime)
            run.nativeStarted = true
            runtime.interruptRequested = true
            void runtime.session.abort().catch(() => undefined)
        }
    }

    private async settleRun(
        id: AgentId,
        runtime: AgentRuntime,
        sequence: number,
        error: unknown,
        permit?: ExecutionPermit,
        limitReached?: AgentLimitReached
    ): Promise<void> {
        const record = this.records.get(id)
        const registered = this.runtimes.get(id)
        if (
            !record ||
            (registered && registered !== runtime) ||
            runtime.runSequence !== sequence
        ) {
            permit?.release()
            this.clearDeadline(id, sequence)
            return
        }
        runtime.phase = 'settling'
        // The model run ended. Parent notification must not retain its slot.
        permit?.release()
        runtime.activePermitSequence = undefined
        this.clearDeadline(id, sequence)
        try {
            this.captureUsage(id, runtime)
            this.captureRecentTurns(id, runtime)
            const lastAssistant = runtime.lastAssistant
            // Provider failures are persisted responses, not rejected prompts.
            const failure =
                error ??
                (lastAssistant?.stopReason === 'error'
                    ? new Error(
                          lastAssistant.errorMessage ||
                              'Provider request failed.'
                      )
                    : undefined)
            const interrupted =
                runtime.interruptRequested ||
                lastAssistant?.stopReason === 'aborted' ||
                isAbortError(error)
            if (limitReached) {
                const status = AgentStatus.errored(limitReached.detail)
                this.setRecord(id, (previous) => ({
                    ...previous,
                    status,
                    limitReached,
                }))
                this.activityFeed.push(
                    record.path,
                    'final',
                    limitReached.detail
                )
                await this.safeDeliverCompletion(record, sequence, status)
            } else if (interrupted) {
                this.setRecord(id, (previous) => ({
                    ...previous,
                    status: AgentStatus.interrupted(),
                }))
            } else if (failure) {
                const message =
                    failure instanceof Error ? failure.message : String(failure)
                const status = AgentStatus.errored(message)
                this.setRecord(id, (previous) => ({ ...previous, status }))
                this.activityFeed.push(record.path, 'final', message)
                await this.safeDeliverCompletion(record, sequence, status)
            } else {
                const status = AgentStatus.completed(
                    assistantText(runtime.lastAssistant) ??
                        runtime.session.getLastAssistantText() ??
                        null
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
                if (status._tag === 'Completed' && status.message) {
                    this.activityFeed.push(record.path, 'final', status.message)
                }
                await this.safeDeliverCompletion(record, sequence, status)
            }
        } finally {
            permit?.release()
            // agent_settled may synchronously schedule another SDK turn while
            // this run is still forwarding its result. Do not erase that run.
            this.clearDeadline(id, sequence)
            if (runtime.runSequence === sequence) {
                runtime.activePermitSequence = undefined
                runtime.currentRun = undefined
                runtime.phase = 'idle'
                runtime.interruptRequested = false
                runtime.lastTouched = Date.now()
                this.nativeRuns.delete(id)
            }
            this.notifyResidencyChange()
            this.scheduleCompletionDrain()
            this.emit({
                _tag: 'ActivityCompleted',
                agentId: id,
                agentPath: record.path,
                parentTurnId: record.initiatingTurnId as never,
            })
        }
    }

    private captureUsage(
        id: AgentId,
        runtime: AgentRuntime,
        finalizedMessage?: AgentMessage
    ): void {
        try {
            const stats = runtime.session.getSessionStats()
            // Under a virtual selection the session model is the selection; the
            // routed model is the physical one that answered.
            const model =
                runtime.session.routedModel?.model ?? runtime.session.model
            let pricing: ModelPricingResolver | undefined
            try {
                pricing = createModelPricingResolver({
                    modelRegistry: this.options.getModelRegistry(),
                })
            } catch {
                // Adapters may provide counters without a model registry.
            }
            const entries = runtime.session.sessionManager.getEntries()
            const reportedEntries =
                finalizedMessage &&
                !entries.some(
                    (entry) =>
                        entry.type === 'message' &&
                        entry.message === finalizedMessage
                )
                    ? [
                          ...entries,
                          { type: 'message', message: finalizedMessage },
                      ]
                    : entries
            const parsed = parseSessionUsage(
                reportedEntries,
                runtime.session.sessionFile ?? 'ephemeral',
                undefined,
                pricing
            )
            const own =
                entries.some(
                    (entry) =>
                        entry.type === 'custom' &&
                        entry.customType === SUBAGENT_META_CUSTOM_TYPE
                ) ||
                parsed.models.length > 0 ||
                parsed.totalTokens.totalTokens > 0 ||
                parsed.totalTokens.cost.total > 0
            const usage: AgentUsageTotals = {
                provider: model?.provider ?? 'unknown',
                modelId: model?.id ?? 'unknown',
                input: own ? parsed.totalTokens.input : stats.tokens.input,
                output: own ? parsed.totalTokens.output : stats.tokens.output,
                cacheRead: own
                    ? parsed.totalTokens.cacheRead
                    : stats.tokens.cacheRead,
                cacheWrite: own
                    ? parsed.totalTokens.cacheWrite
                    : stats.tokens.cacheWrite,
                cost: own ? parsed.totalTokens.cost.total : stats.cost,
                userMessages: own ? parsed.userMessages : stats.userMessages,
                assistantMessages: own
                    ? parsed.assistantMessages
                    : stats.assistantMessages,
                toolResults: own ? parsed.toolResults : stats.toolResults,
                toolCalls: parsed.toolCalls,
                ...(own ? { models: parsed.models } : {}),
            }
            const previousUsage = this.records.get(id)?.usage
            this.setRecord(id, (previous) => ({ ...previous, usage }))
            this.emit({ _tag: 'UsageUpdated', agentId: id })
            const delta = Math.max(
                0,
                usageTokens(usage) - usageTokens(previousUsage)
            )
            if (delta > 0) {
                this.budget.record(delta)
                this.emitLimitsChanged()
                const snapshot = this.budget.snapshot()
                if (snapshot.exhausted && snapshot.limit !== undefined) {
                    const run = this.nativeRuns.get(id)
                    if (
                        run &&
                        run.runtime === runtime &&
                        !run.settled &&
                        !run.limitReached
                    ) {
                        const error = new TokenBudgetExhaustedError(
                            snapshot.consumed,
                            snapshot.limit
                        )
                        run.limitReached = {
                            kind: 'tokens',
                            detail: error.message,
                        }
                        void runtime.session.abort().catch(() => undefined)
                    }
                }
            }
        } catch {
            // Diagnostics must never affect run settlement.
        }
    }

    /**
     * Terminal results bypass token admission by design. A budget exhaustion
     * must not strand a completed child result, so delivery is attempted even
     * when new work would be refused.
     */
    private async safeDeliverCompletion(
        record: AgentRecord,
        sequence: number,
        status: AgentRecord['status']
    ): Promise<void> {
        if (
            record.lastDeliveredRunSequence !== undefined &&
            record.lastDeliveredRunSequence >= sequence
        )
            return
        // Usage, start time, and transcript reference land on the stored record
        // during settlement, so read the current one instead of the snapshot.
        const current = this.records.get(record.id) ?? record
        const formatted = formatCompletionResult({
            status,
            sessionFile: current.sessionFile,
            sessionId: current.sessionId,
        })
        if (formatted === null || !record.parentPath) return
        const existing = (current.pendingCompletions ?? []).find(
            (pending) => pending.runSequence === sequence
        )
        const pending =
            existing ??
            this.queuePendingCompletion(record.id, sequence, {
                id: newCommunicationId(),
                kind: 'result',
                messageType: 'FINAL_ANSWER',
                author: record.path,
                recipient: record.parentPath,
                payload: formatted.payload,
                triggerTurn: true,
                meta: {
                    ...completionMeta(current, status),
                    ...(formatted.truncated ? { truncated: true } : {}),
                    ...(formatted.fullResultRef
                        ? { fullResultRef: formatted.fullResultRef }
                        : {}),
                },
            })
        if (this.receiptsEnabled && !existing) {
            this.unconfirmedIntents.add(pending.communicationId)
            try {
                await this.checkpointDelivery(
                    'intent-persisted',
                    record.id,
                    pending.recipient,
                    sequence,
                    pending.communicationId
                )
            } catch {
                // The outbox entry remains, but it is not dispatchable until a
                // durable intent checkpoint succeeds.
                return
            }
            this.unconfirmedIntents.delete(pending.communicationId)
        }
        try {
            await this.deliverCompletion(
                record.id,
                sequence,
                pendingCommunication(pending)
            )
        } catch {
            // The outbox entry was written before dispatch and remains pending.
        }
    }

    private async deliverCompletion(
        childId: AgentId,
        sequence: number,
        communication: InterAgentCommunication,
        retry = false
    ): Promise<void> {
        const current = this.records.get(childId)
        if (!current) return
        if ((current.lastDeliveredRunSequence ?? -1) >= sequence) {
            await this.acknowledgeCompletion(
                childId,
                sequence,
                communication.id
            )
            return
        }
        const key = `${childId}:${sequence}`
        const pending = this.completionDeliveries.get(key)
        if (pending) return await pending
        const delivery = this.trackDeliveryOperation(
            this.sendCompletion(childId, sequence, communication, retry)
        )
        this.completionDeliveries.set(key, delivery)
        try {
            await delivery
        } finally {
            this.completionDeliveries.delete(key)
        }
    }

    private async sendCompletion(
        childId: AgentId,
        sequence: number,
        communication: InterAgentCommunication,
        retry: boolean
    ): Promise<void> {
        if (!this.receiptsEnabled) {
            await this.sendCompletionLegacy(childId, sequence, communication)
            return
        }
        const parent = this.getRecordByPath(communication.recipient)
        if (!parent) throw new AgentNotFoundError(communication.recipient)
        if (this.deliveryDetached) return
        if (this.unconfirmedIntents.has(communication.id)) return

        const parentLease =
            parent.path === ROOT_PATH
                ? undefined
                : await this.leaseRuntime(parent.id)
        try {
            const endpoint =
                parent.path === ROOT_PATH
                    ? this.options.rootEndpoint
                    : parentLease!.runtime.endpoint!
            const observed = await this.probeEndpoint(
                endpoint,
                communication.id
            )
            if (observed === 'accepted') {
                await this.acknowledgeCompletion(
                    childId,
                    sequence,
                    communication.id
                )
                return
            }
            if (observed === 'unknown') return
            if (this.outstandingDispatches.has(communication.id)) return
            if (this.deliveryDetached) return

            if (retry) {
                try {
                    await this.checkpointDelivery(
                        'dispatch-retry',
                        childId,
                        parent.path,
                        sequence,
                        communication.id
                    )
                } catch {
                    return
                }
            }

            if (parent.path === ROOT_PATH) {
                this.markOutstanding(
                    childId,
                    sequence,
                    communication.id,
                    parent.path
                )
                try {
                    // Root send is fire-and-forget by contract. This await only
                    // observes synchronous callback invocation, never insertion.
                    await endpoint.send(communication, {
                        triggerTurn: true,
                        delivery: 'steer',
                    })
                } catch (error) {
                    this.failOutstanding(communication.id)
                    throw error
                }
            } else {
                const runtime = parentLease!.runtime
                await this.mutex(parent.id).runExclusive(async () => {
                    if (this.deliveryDetached) return
                    const current = this.records.get(childId)
                    if (
                        !current ||
                        (current.lastDeliveredRunSequence ?? -1) >= sequence
                    ) {
                        if (current) {
                            await this.acknowledgeCompletion(
                                childId,
                                sequence,
                                communication.id
                            )
                        }
                        return
                    }
                    const receipt = {
                        childId,
                        sequence,
                        communicationId: communication.id,
                        recipient: parent.path,
                    }
                    if (runtime.session.isStreaming) {
                        this.markOutstanding(
                            childId,
                            sequence,
                            communication.id,
                            parent.path
                        )
                        try {
                            await runtime.endpoint!.send(communication, {
                                triggerTurn: true,
                                delivery: 'steer',
                            })
                        } catch (error) {
                            this.failOutstanding(communication.id)
                            throw error
                        }
                    } else {
                        // Completion delivery bypasses token/request admission
                        // by design: results must still reach a parent after the
                        // shared budget is exhausted.
                        await this.startRun(
                            parent.id,
                            communication,
                            undefined,
                            receipt
                        )
                    }
                })
            }

            const after = await this.probeEndpoint(endpoint, communication.id)
            if (after === 'accepted') {
                await this.acknowledgeCompletion(
                    childId,
                    sequence,
                    communication.id
                )
            }
        } finally {
            parentLease?.release()
        }
        this.waitHub.notifyMailbox(parent.path as string)
    }

    private async sendCompletionLegacy(
        childId: AgentId,
        sequence: number,
        communication: InterAgentCommunication
    ): Promise<void> {
        const parent = this.getRecordByPath(communication.recipient)
        if (!parent) throw new AgentNotFoundError(communication.recipient)
        if (parent.path === ROOT_PATH) {
            await this.options.rootEndpoint.send(communication, {
                triggerTurn: true,
                delivery: 'steer',
            })
            await this.acknowledgeCompletion(
                childId,
                sequence,
                communication.id
            )
        } else {
            const lease = await this.leaseRuntime(parent.id)
            try {
                const runtime = lease.runtime
                await this.mutex(parent.id).runExclusive(async () => {
                    const current = this.records.get(childId)
                    if (
                        !current ||
                        (current.lastDeliveredRunSequence ?? -1) >= sequence
                    ) {
                        if (current) {
                            await this.acknowledgeCompletion(
                                childId,
                                sequence,
                                communication.id
                            )
                        }
                        return
                    }
                    if (runtime.session.isStreaming) {
                        await runtime.endpoint!.send(communication, {
                            triggerTurn: true,
                            delivery: 'steer',
                        })
                    } else {
                        if (runtime.currentRun) await runtime.currentRun
                        await this.startRun(parent.id, communication)
                    }
                    await this.acknowledgeCompletion(
                        childId,
                        sequence,
                        communication.id
                    )
                })
            } finally {
                lease.release()
            }
        }
        this.waitHub.notifyMailbox(parent.path as string)
    }

    private async acknowledgeCompletion(
        childId: AgentId,
        sequence: number,
        communicationId?: string
    ): Promise<boolean> {
        if (this.deliveryDetached) return false
        return await this.ackMutex(childId).runExclusive(async () => {
            const previous = this.records.get(childId)
            if (!previous) return false
            const previousSequence = previous.lastDeliveredRunSequence
            const previousPending = previous.pendingCompletions
            const acknowledged = Math.max(previousSequence ?? 0, sequence)
            const removedPending = (previousPending ?? []).filter(
                (pending) => pending.runSequence <= acknowledged
            )
            const id =
                communicationId ??
                removedPending.find(
                    (pending) => pending.runSequence === sequence
                )?.communicationId ??
                ''
            this.setRecord(childId, (record) => ({
                ...record,
                lastDeliveredRunSequence: acknowledged,
                pendingCompletions: (record.pendingCompletions ?? []).filter(
                    (pending) => pending.runSequence > acknowledged
                ),
            }))
            if (this.receiptsEnabled) {
                try {
                    await this.checkpointDelivery(
                        'receipt-accepted',
                        childId,
                        previous.parentPath ?? ROOT_PATH,
                        sequence,
                        id
                    )
                } catch {
                    // A newer run may have queued another completion while the
                    // checkpoint was awaiting. Restore only what this ack
                    // removed and preserve concurrent intents.
                    this.setRecord(childId, (record) => {
                        const current = record.pendingCompletions ?? []
                        const sequences = new Set(
                            current.map((pending) => pending.runSequence)
                        )
                        const ids = new Set(
                            current.map((pending) => pending.communicationId)
                        )
                        const restored = [...current]
                        for (const pending of removedPending) {
                            if (
                                sequences.has(pending.runSequence) ||
                                ids.has(pending.communicationId)
                            ) {
                                continue
                            }
                            restored.push(pending)
                            sequences.add(pending.runSequence)
                            ids.add(pending.communicationId)
                        }
                        restored.sort(
                            (left, right) =>
                                left.runSequence - right.runSequence
                        )
                        return {
                            ...record,
                            lastDeliveredRunSequence:
                                record.lastDeliveredRunSequence === acknowledged
                                    ? previousSequence
                                    : record.lastDeliveredRunSequence,
                            pendingCompletions: restored,
                        }
                    })
                    return false
                }
            }
            if (id) this.clearOutstanding(id)
            return true
        })
    }

    private queuePendingCompletion(
        childId: AgentId,
        sequence: number,
        communication: InterAgentCommunication
    ): PendingCompletion {
        const pending: PendingCompletion = {
            communicationId: communication.id,
            runSequence: sequence,
            author: communication.author,
            recipient: communication.recipient,
            payload: communication.payload,
            meta: communication.meta,
        }
        this.setRecord(childId, (previous) => ({
            ...previous,
            pendingCompletions: [
                ...(previous.pendingCompletions ?? []).filter(
                    (item) => item.runSequence !== sequence
                ),
                pending,
            ],
        }))
        return pending
    }

    private markOutstanding(
        childId: AgentId,
        sequence: number,
        communicationId: string,
        recipient: AgentPath
    ): void {
        this.outstandingDispatches.set(communicationId, {
            communicationId,
            childId,
            recipient,
            runSequence: sequence,
            epochAtDispatch: this.deliveryEpochs.get(recipient as string) ?? 0,
            failed: false,
        })
    }

    private failOutstanding(communicationId: string): void {
        const dispatch = this.outstandingDispatches.get(communicationId)
        if (dispatch) dispatch.failed = true
    }

    private clearOutstanding(communicationId: string): void {
        this.outstandingDispatches.delete(communicationId)
    }

    private async probeEndpoint(
        endpoint: CommunicationEndpoint,
        communicationId: string
    ): Promise<InsertionState> {
        if (!endpoint.probeInsertion) {
            throw new Error(
                'Delivery receipts are enabled but the endpoint has no insertion probe.'
            )
        }
        try {
            return await endpoint.probeInsertion(communicationId)
        } catch {
            return 'unknown'
        }
    }

    private async probeRecipient(
        recipient: AgentRecord,
        communicationId: string
    ): Promise<InsertionState> {
        if (recipient.path === ROOT_PATH) {
            return await this.probeEndpoint(
                this.options.rootEndpoint,
                communicationId
            )
        }
        const lease = await this.leaseRuntime(recipient.id)
        try {
            return await this.probeEndpoint(
                lease.runtime.endpoint!,
                communicationId
            )
        } finally {
            lease.release()
        }
    }

    async retryPendingCompletions(recipient: AgentPath): Promise<void> {
        if (this.receiptsEnabled) {
            await this.reconcileDeliveryReceipts(recipient)
            return
        }
        const pending = [...this.records.values()].flatMap((record) =>
            (record.pendingCompletions ?? [])
                .filter((item) => item.recipient === recipient)
                .map((item) => ({ childId: record.id, item }))
        )
        for (const { childId, item } of pending) {
            try {
                await this.deliverCompletion(
                    childId,
                    item.runSequence,
                    pendingCommunication(item)
                )
            } catch {
                // Keep the durable outbox entry for the next load or root start.
            }
        }
    }

    private hasUndeliveredCompletion(recipient: AgentPath): boolean {
        return [...this.records.values()].some((record) =>
            (record.pendingCompletions ?? []).some(
                (item) => item.recipient === recipient
            )
        )
    }

    private hasPendingFor(recipient: AgentPath): boolean {
        return this.hasUndeliveredCompletion(recipient)
    }

    /**
     * Observe durable recipient insertion. `terminal` advances the recipient
     * epoch; `forceRetry` is only valid after the host confirms the recipient
     * is idle. An 'unknown' probe never authorizes a resend.
     */
    async reconcileDeliveryReceipts(
        recipient: AgentPath = ROOT_PATH,
        options: ReconcileDeliveryOptions = {}
    ): Promise<void> {
        if (!this.receiptsEnabled || this.deliveryDetached) return
        if (options.terminal) {
            this.deliveryEpochs.set(
                recipient as string,
                (this.deliveryEpochs.get(recipient as string) ?? 0) + 1
            )
        }
        const recipientRecord = this.getRecordByPath(recipient)
        if (!recipientRecord) return
        const pending = [...this.records.values()].flatMap((record) =>
            (record.pendingCompletions ?? [])
                .filter((item) => item.recipient === recipient)
                .map((item) => ({ childId: record.id, item }))
        )
        for (const { childId, item } of pending) {
            if (this.deliveryDetached) return
            try {
                if (this.unconfirmedIntents.has(item.communicationId)) {
                    await this.checkpointDelivery(
                        'intent-persisted',
                        childId,
                        item.recipient,
                        item.runSequence,
                        item.communicationId
                    )
                    this.unconfirmedIntents.delete(item.communicationId)
                }
                const observed = await this.probeRecipient(
                    recipientRecord,
                    item.communicationId
                )
                if (observed === 'accepted') {
                    await this.acknowledgeCompletion(
                        childId,
                        item.runSequence,
                        item.communicationId
                    )
                    continue
                }
                if (observed === 'unknown') continue
                if (this.unconfirmedIntents.has(item.communicationId)) continue
                const outstanding = this.outstandingDispatches.get(
                    item.communicationId
                )
                if (outstanding) {
                    const epoch =
                        this.deliveryEpochs.get(recipient as string) ?? 0
                    const retryEligible =
                        options.forceRetry ||
                        (options.terminal &&
                            outstanding.epochAtDispatch < epoch)
                    if (!retryEligible) continue
                    this.clearOutstanding(item.communicationId)
                }
                await this.deliverCompletion(
                    childId,
                    item.runSequence,
                    pendingCommunication(item),
                    true
                )
            } catch {
                // Keep the durable outbox entry for the next reconciliation.
            }
        }
    }

    /** Coalesce retries after residency changes or freed execution slots. */
    private scheduleCompletionDrain(): void {
        if (this.shutdownFlag || this.deliveryDetached) return
        this.completionDrainRequested = true
        if (this.completionDrain) return
        this.completionDrain = Promise.resolve()
            .then(async () => {
                while (
                    this.completionDrainRequested &&
                    !this.shutdownFlag &&
                    !this.deliveryDetached
                ) {
                    this.completionDrainRequested = false
                    const recipients = new Set<AgentPath>()
                    for (const record of this.records.values()) {
                        for (const pending of record.pendingCompletions ?? []) {
                            const recipient = this.getRecordByPath(
                                pending.recipient
                            )
                            // Do not evict useful sessions merely to retry an outbox.
                            if (
                                recipient &&
                                (recipient.path === ROOT_PATH ||
                                    this.runtimes.has(recipient.id))
                            ) {
                                recipients.add(recipient.path)
                            }
                        }
                    }
                    for (const recipient of recipients) {
                        if (this.shutdownFlag || this.deliveryDetached) break
                        await this.retryPendingCompletions(recipient)
                    }
                }
            })
            .finally(() => {
                this.completionDrain = undefined
                if (
                    this.completionDrainRequested &&
                    !this.shutdownFlag &&
                    !this.deliveryDetached
                )
                    this.scheduleCompletionDrain()
            })
    }

    private pinRuntime(id: AgentId): void {
        this.runtimePins.set(id, (this.runtimePins.get(id) ?? 0) + 1)
    }

    private unpinRuntime(id: AgentId): void {
        const remaining = (this.runtimePins.get(id) ?? 1) - 1
        if (remaining > 0) this.runtimePins.set(id, remaining)
        else this.runtimePins.delete(id)
        this.notifyResidencyChange()
    }

    private notifyResidencyChange(): void {
        this.residencyGeneration += 1
        for (const resolve of [...this.residencyWaiters]) resolve()
        this.residencyWaiters.clear()
    }

    private waitForResidencyChange(since: number): Promise<void> {
        if (this.shutdownFlag || this.residencyGeneration !== since)
            return Promise.resolve()
        return new Promise((resolve) => {
            this.residencyWaiters.add(resolve)
            if (this.shutdownFlag || this.residencyGeneration !== since)
                resolve()
        })
    }

    /**
     * Pin the runtime for the full operation. The pin is taken before the cold
     * load so LRU cannot register then immediately evict the session before
     * the caller receives its lease.
     */
    private async leaseRuntime(id: AgentId): Promise<RuntimeLease> {
        this.pinRuntime(id)
        let runtime: AgentRuntime
        try {
            runtime = await this.ensureLoaded(id)
        } catch (error) {
            this.unpinRuntime(id)
            throw error
        }
        let released = false
        return {
            runtime,
            release: () => {
                if (released) return
                released = true
                this.unpinRuntime(id)
            },
        }
    }

    private leaseExistingRuntime(id: AgentId): RuntimeLease | undefined {
        const runtime = this.runtimes.get(id)
        if (!runtime) return undefined
        this.pinRuntime(id)
        let released = false
        return {
            runtime,
            release: () => {
                if (released) return
                released = true
                this.unpinRuntime(id)
            },
        }
    }

    private ensureLoaded(id: AgentId): Promise<AgentRuntime> {
        const existing = this.runtimes.get(id)
        if (existing) {
            if (this.records.get(id)?.blocked) {
                this.setRecord(id, (record) => ({
                    ...record,
                    blocked: undefined,
                }))
            }
            return Promise.resolve(existing)
        }
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
            while (!this.shutdownFlag) {
                const generation = this.residencyGeneration
                const runtime = await this.residencyMutex.runExclusive(
                    async () => {
                        const existing = this.runtimes.get(id)
                        if (existing) return existing
                        if (!(await this.evictOneIfRequired(id)))
                            return undefined
                        const opened = await this.factory.open(record)
                        return await this.registerRuntime(record, opened)
                    }
                )
                if (runtime) return runtime
                await this.waitForResidencyChange(generation)
            }
            throw new Error('session is shutting down')
        } catch (error) {
            if (error instanceof AgentBlockedError) {
                this.setRecord(id, (previous) => ({
                    ...previous,
                    residency: 'unloaded',
                    blocked: { code: error.code, reason: error.reason },
                }))
                throw error
            }
            this.setRecord(id, (previous) => ({
                ...previous,
                residency: 'unloaded',
                blocked: undefined,
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
        while (!this.shutdownFlag) {
            const generation = this.residencyGeneration
            const runtime = await this.residencyMutex.runExclusive(async () => {
                if (!(await this.evictOneIfRequired(record.id)))
                    return undefined
                const created = await this.factory.create(
                    record,
                    parentSnapshot,
                    fork
                )
                return await this.registerRuntime(record, created)
            })
            if (runtime) return runtime
            await this.waitForResidencyChange(generation)
        }
        throw new Error('session is shutting down')
    }

    private async registerRuntime(
        record: AgentRecord,
        runtime: AgentRuntime
    ): Promise<AgentRuntime> {
        if (this.shutdownFlag) {
            await runtime.dispose()
            throw new Error('session is shutting down')
        }
        this.observeRuntime(record, runtime)
        this.notifyResidencyChange()
        runtime.endpoint = childEndpoint(
            record.path,
            runtime.session,
            this.receiptsEnabled
                ? sessionInsertionProbe(runtime.session)
                : undefined
        )
        this.runtimes.set(record.id, runtime)
        this.sessionBindings.set(runtime.session.sessionId, record.id)
        this.setRecord(record.id, (previous) => ({
            ...previous,
            residency: 'loaded',
            sessionId: runtime.session.sessionId,
            sessionFile: runtime.session.sessionFile,
            activeTools: runtime.session.getActiveToolNames(),
            thinkingLevel: runtime.session.thinkingLevel,
            blocked: undefined,
        }))
        this.captureRecentTurns(record.id, runtime)
        this.scheduleCompletionDrain()
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
        const lease = await this.leaseRuntime(record.id)
        try {
            const runtime = lease.runtime
            return {
                path: record.path,
                cwd: runtime.session.sessionManager.getCwd(),
                model: {
                    provider:
                        runtime.session.model?.provider ??
                        parseModel(record.model).provider,
                    id:
                        runtime.session.model?.id ??
                        parseModel(record.model).id,
                },
                thinkingLevel: runtime.session.thinkingLevel,
                activeTools: runtime.session.getActiveToolNames(),
                contextEntries: runtime.session.sessionManager.getBranch(),
                sessionFile: runtime.session.sessionFile,
                sessionId: runtime.session.sessionId,
            }
        } finally {
            lease.release()
        }
    }

    private async evictOneIfRequired(exceptId: AgentId): Promise<boolean> {
        if (this.runtimes.size < this.options.config.maxLoadedAgents)
            return true
        const candidates = [...this.records.values()]
            .filter((record) => record.id !== exceptId)
            .filter((record) => record.path !== ROOT_PATH)
            .filter((record) => {
                const runtime = this.runtimes.get(record.id)
                return Boolean(
                    runtime &&
                    !runtime.session.isStreaming &&
                    !runtime.currentRun &&
                    (this.runtimePins.get(record.id) ?? 0) === 0 &&
                    record.status._tag !== 'PendingInit' &&
                    record.status._tag !== 'Running'
                )
            })
            .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
        const victim = candidates[0]
        if (!victim) return false
        const runtime = this.runtimes.get(victim.id)
        if (!runtime) return false
        this.captureRecentTurns(victim.id, runtime)
        // Remove the residency before awaiting disposal. A concurrent
        // ensureLoaded must not observe and pin a session that is closing.
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
        await runtime.dispose()
        this.notifyResidencyChange()
        return true
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

    private ackMutex(id: AgentId): AgentMutex {
        let mutex = this.ackMutexes.get(id)
        if (!mutex) {
            mutex = new AgentMutex()
            this.ackMutexes.set(id, mutex)
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

function usageTokens(usage: AgentUsageTotals | undefined): number {
    if (!usage) return 0
    const total =
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    return Number.isSafeInteger(total) && total > 0 ? total : 0
}

function pendingCommunication(
    pending: PendingCompletion
): InterAgentCommunication {
    return {
        id: pending.communicationId,
        kind: 'result',
        messageType: 'FINAL_ANSWER',
        author: pending.author,
        recipient: pending.recipient,
        payload: pending.payload,
        triggerTurn: true,
        meta: pending.meta,
    }
}

/** Transcript metadata for one terminal child result. */
function completionMeta(
    record: AgentRecord,
    status: AgentRecord['status']
): FinalAnswerMeta {
    const usage = record.usage
    const tokens = usage
        ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
        : 0
    return {
        ...(record.role ? { role: record.role } : {}),
        model: record.model,
        ...(record.runStartedAt !== undefined
            ? { durationMs: Math.max(0, Date.now() - record.runStartedAt) }
            : {}),
        ...(tokens > 0 ? { tokens } : {}),
        ...(usage && usage.cost > 0 ? { cost: usage.cost } : {}),
        ...(status._tag === 'Errored' ? { failed: true } : {}),
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
    if (!(error instanceof Error)) return false
    if (error.name === 'AbortError') return true
    const code = (error as { code?: unknown }).code
    return code === 'ABORT_ERR' || code === 'ABORTED'
}

function assistantText(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') return undefined
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return undefined
    const text = content
        .map((part) => {
            if (!part || typeof part !== 'object') return ''
            const value = part as { type?: unknown; text?: unknown }
            return value.type === 'text' && typeof value.text === 'string'
                ? value.text
                : ''
        })
        .filter(Boolean)
        .join('\n')
    return text.length > 0 ? text : undefined
}

function withNote(message: string, note: string | null): string {
    return note ? `${message} ${note}` : message
}
