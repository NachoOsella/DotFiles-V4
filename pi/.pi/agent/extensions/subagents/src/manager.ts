/**
 * Central translation of Rust AgentControl.
 * Composes the logical registry, mailbox, capacity, runtime store,
 * residency, and communication services. host-live.ts owns raw Pi APIs;
 * this file owns multi-agent state transitions.
 *
 * Invariants (see docs/ARCHITECTURE.md):
 * - Identity != loaded session. Completed/Interrupted != destroyed.
 * - Parent turn lifetime != child lifetime (children are background
 *   promises, never structural children of the calling tool execution).
 * - send_message != followup_task. wait_agent != result retrieval.
 * - Capacity counts active non-root turns and rejects immediately.
 */

import {
    InvalidTaskNameError,
    isRootPath,
    isValidTaskName,
    joinAgentPath,
    parentAgentPath,
    parseAgentPath,
    pathMatchesPrefix,
    resolveTarget,
    ROOT_PATH,
} from './agent-path.ts'
import { AgentStatus, type AgentResidency } from './agent-status.ts'
import {
    addUsageDelta,
    type AgentRecord,
    type AgentRecordInit,
    type AgentUsageTotals,
} from './agent-record.ts'
import {
    assertNonEmptyMessage,
    finalAnswerCommunication,
    newTaskCommunication,
    parseForkTurns,
    plainMessageCommunication,
    renderCommunicationText,
    type ForkTurns,
    type InterAgentCommunication,
} from './communication.ts'
import { formatFinalAnswer } from './completion.ts'
import {
    DEFAULT_SUBAGENTS_CONFIG,
    clampWaitTimeout,
    type CodexSubagentsConfig,
} from './config.ts'
import {
    AgentAlreadyExistsError,
    AgentCapacityReachedError,
    AgentNotFoundError,
    AgentSpawnFailedError,
    InvalidModelOverrideError,
    RootFollowupForbiddenError,
    SelfInterruptForbiddenError,
} from './errors.ts'
import type { SubagentEvent } from './events.ts'
import {
    newAgentId,
    newTurnId,
    type AgentId,
    type AgentPath,
    type ToolCallId,
} from './ids.ts'
import {
    subtractSessionUsage,
    type HostSessionHandle,
    type PiHost,
    type SessionUsage,
} from './host.ts'

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

export interface SpawnOptions {
    readonly caller: AgentPath
    readonly taskName: string
    readonly message: string
    readonly forkTurns?: string
    readonly agentType?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly parentHistory?: readonly string[]
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

interface RuntimeEntry {
    session: HostSessionHandle
    sessionIdBinding: string | null
    abortController: AbortController | null
    running: boolean
    turnPromise: Promise<void> | null
    lastTouched: number
}

const WAIT_COMPLETED = 'Wait completed.'
const WAIT_INTERRUPTED = 'Wait interrupted by new input.'
const WAIT_TIMED_OUT = 'Wait timed out.'

export class SubagentManager {
    private records = new Map<AgentId, AgentRecord>()
    private pathIndex = new Map<string, AgentId>()
    private mailboxes = new Map<AgentId, InterAgentCommunication[]>()
    private waiters = new Map<AgentId, Set<() => void>>()
    private steerWaiters = new Map<AgentId, Set<() => void>>()
    private runtimes = new Map<AgentId, RuntimeEntry>()
    private activeTurns = new Set<AgentId>()
    private listeners = new Set<(event: SubagentEvent) => void>()
    private sessionBindings = new Map<string, AgentId>()
    private usageTotals = new Map<AgentId, AgentUsageTotals>()
    private usageBaselines = new Map<string, SessionUsage>()
    private rootId: AgentId
    private shutdownFlag = false
    private host: PiHost
    private config: CodexSubagentsConfig

    constructor(
        host: PiHost,
        config: CodexSubagentsConfig = DEFAULT_SUBAGENTS_CONFIG
    ) {
        this.host = host
        this.config = config
        const id = newAgentId()
        this.rootId = id
        const now = Date.now()
        const root: AgentRecord = {
            id,
            path: ROOT_PATH,
            parentId: null,
            parentPath: null,
            status: AgentStatus.running(),
            residency: 'loaded',
            model: 'root',
            createdAt: now,
            lastActivityAt: now,
        }
        this.records.set(id, root)
        this.pathIndex.set(ROOT_PATH as string, id)
        this.mailboxes.set(id, [])
    }

    /** Subscribe to domain events (TUI, persistence, telemetry). */
    onEvent(listener: (event: SubagentEvent) => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    private emit(event: SubagentEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event)
            } catch {
                // Listener failures must not corrupt lifecycle state.
            }
        }
    }

    /** Bind a Pi session id to an agent path for caller resolution. */
    bindSession(sessionId: string, path: AgentPath): void {
        const id = this.pathIndex.get(path as string)
        if (id) this.sessionBindings.set(sessionId, id)
    }

    /** Resolve the calling agent from a Pi session id (default /root). */
    callerFromSession(sessionId: string | undefined): AgentPath {
        if (!sessionId) return ROOT_PATH
        const id = this.sessionBindings.get(sessionId)
        if (!id) return ROOT_PATH
        return this.records.get(id)?.path ?? ROOT_PATH
    }

    getConfig(): CodexSubagentsConfig {
        return this.config
    }

    getRecordByPath(path: AgentPath): AgentRecord | undefined {
        const id = this.pathIndex.get(path as string)
        return id ? this.records.get(id) : undefined
    }

    getRecordById(id: AgentId): AgentRecord | undefined {
        return this.records.get(id)
    }

    /** Logical list; never loads sessions. */
    list(from: AgentPath, prefix?: string): ListedAgent[] {
        void from
        const out: ListedAgent[] = []
        for (const record of this.records.values()) {
            if (record.path === ('/root' as AgentPath)) continue
            if (prefix && !pathMatchesPrefix(record.path, prefix)) continue
            const runtime = this.runtimes.get(record.id)
            out.push({
                path: record.path,
                status: record.status._tag,
                residency: record.residency,
                role: record.role,
                model: record.model,
                parentPath: record.parentPath,
                hasPendingMail:
                    (this.mailboxes.get(record.id) ?? []).length > 0,
                running: runtime?.running ?? false,
            })
        }
        out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        return out
    }

    /** Resolve a tool target relative to the caller. */
    resolve(from: AgentPath, target: string): AgentRecord {
        const path = resolveTarget(from, target)
        const record = this.getRecordByPath(path)
        if (!record) throw new AgentNotFoundError(path as string)
        return record
    }

    async spawn(options: SpawnOptions): Promise<SpawnResult> {
        if (this.shutdownFlag) {
            throw new AgentSpawnFailedError('session is shutting down')
        }
        assertNonEmptyMessage(options.message)
        if (
            options.taskName.trim().length === 0 ||
            !isValidTaskName(options.taskName)
        ) {
            throw new InvalidTaskNameError(options.taskName)
        }
        const fork = parseForkTurns(options.forkTurns)
        const callerRecord = this.getRecordByPath(options.caller)
        if (!callerRecord)
            throw new AgentNotFoundError(options.caller as string)

        // Resolve inheritance before the atomic reserve. History selection and
        // model selection are independent, including full-history forks.
        const parentSnapshot = await this.host.getModel()
        const parentModel =
            callerRecord.model !== 'root'
                ? callerRecord.model
                : `${parentSnapshot.provider}/${parentSnapshot.id}`
        const wantsOverride =
            options.model !== undefined || options.reasoningEffort !== undefined
        if (wantsOverride && !this.config.exposeSpawnAgentModelOverrides) {
            throw new InvalidModelOverrideError(
                'model overrides are not exposed; omit model/reasoning_effort'
            )
        }
        if (
            options.forkTurns !== undefined &&
            options.forkTurns.trim().toLowerCase() === 'fork_context'
        ) {
            throw new InvalidModelOverrideError(
                'fork_context is removed; use fork_turns'
            )
        }
        const model = options.model ?? parentModel

        // Atomic reserve: check + insert with no await between.
        const childPath = joinAgentPath(options.caller, options.taskName)
        if (this.pathIndex.has(childPath as string)) {
            throw new AgentAlreadyExistsError(childPath as string)
        }
        if (this.activeTurns.size >= this.config.maxConcurrentAgents) {
            throw new AgentCapacityReachedError(
                this.config.maxConcurrentAgents,
                this.activeTurns.size
            )
        }
        const now = Date.now()
        const id = newAgentId()
        const init: AgentRecordInit = {
            id,
            path: childPath,
            parentId: callerRecord.id,
            parentPath: callerRecord.path,
            role: options.agentType,
            model,
            reasoningEffort: options.reasoningEffort,
            initiatingTurnId: newTurnId() as string,
            forkKind: fork._tag,
        }
        const record: AgentRecord = {
            ...init,
            status: AgentStatus.pendingInit(),
            residency: 'loading',
            createdAt: now,
            lastActivityAt: now,
        }
        this.records.set(id, record)
        this.pathIndex.set(childPath as string, id)
        this.mailboxes.set(id, [])
        this.activeTurns.add(id)

        const parentHistory = options.parentHistory ?? []
        const forkMessages = selectHistory(parentHistory, fork)
        const callId = options.callId ?? (`spawn-${Date.now()}` as ToolCallId)
        const parentTurn = (callerRecord.initiatingTurnId ??
            newTurnId()) as unknown as import('./ids.ts').TurnId

        try {
            await this.evictOneIfRequired(id)
            const session = await this.host.createSession({
                agentPath: childPath,
                fork,
                parentHistory: forkMessages,
                model,
                reasoningEffort: options.reasoningEffort,
                role: options.agentType,
            })
            this.runtimes.set(id, {
                session,
                sessionIdBinding: null,
                abortController: null,
                running: false,
                turnPromise: null,
                lastTouched: Date.now(),
            })
            this.setRecord(id, (prev) => ({
                ...prev,
                residency: 'loaded' as AgentResidency,
            }))
            const comm = newTaskCommunication({
                kind: 'spawn',
                author: options.caller,
                recipient: childPath,
                payload: options.message,
                sourceCallId: callId,
            })
            this.enqueueTo(id, comm)
            this.emit({
                _tag: 'ActivityStarted',
                callId,
                agentId: id,
                agentPath: childPath,
                parentTurnId: parentTurn,
            })
        } catch (error) {
            // Roll back the reservation; the child never became durable.
            this.records.delete(id)
            this.pathIndex.delete(childPath as string)
            this.mailboxes.delete(id)
            this.activeTurns.delete(id)
            this.usageTotals.delete(id)
            this.runtimes.delete(id)
            throw error instanceof Error
                ? error
                : new AgentSpawnFailedError(String(error))
        }

        // Start the turn in the session scope (background; never awaited here).
        void this.startTurn(id, options.message)
        return { path: childPath, id }
    }

    async sendMessage(args: {
        caller: AgentPath
        target: string
        message: string
        callId?: ToolCallId
    }): Promise<void> {
        assertNonEmptyMessage(args.message)
        const target = this.resolve(args.caller, args.target)
        await this.ensureLoaded(target.id)
        const comm = plainMessageCommunication({
            author: args.caller,
            recipient: target.path,
            payload: args.message,
            sourceCallId: args.callId,
        })
        this.enqueueTo(target.id, comm)
        this.touch(target.id)
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
        await this.ensureLoaded(target.id)
        const comm = newTaskCommunication({
            kind: 'followup',
            author: args.caller,
            recipient: target.path,
            payload: args.message,
            sourceCallId: args.callId,
        })
        this.enqueueTo(target.id, comm)
        this.touch(target.id)
        this.emit({
            _tag: 'ActivityInteracted',
            callId: args.callId ?? (`followup-${Date.now()}` as ToolCallId),
            agentId: target.id,
            agentPath: target.path,
        })
        const runtime = this.runtimes.get(target.id)
        if (!runtime?.running) {
            void this.startTurn(target.id, args.message)
        }
    }

    async interrupt(args: {
        caller: AgentPath
        target: string
        callId?: ToolCallId
    }): Promise<AgentRecord['status']> {
        const targetPath = resolveTarget(args.caller, args.target)
        if (isRootPath(targetPath)) throw new SelfInterruptForbiddenError()
        if (targetPath === args.caller) throw new SelfInterruptForbiddenError()
        const target = this.getRecordByPath(targetPath)
        if (!target) throw new AgentNotFoundError(targetPath as string)
        const runtime = this.runtimes.get(target.id)
        const previous = target.status
        if (!runtime?.running) return previous
        runtime.abortController?.abort()
        try {
            await this.host.interruptTurn(runtime.session)
        } catch {
            // Host abort is best-effort; the controller signal is authoritative.
        }
        try {
            await runtime.turnPromise
        } catch {
            // Turn outcome is recorded by startTurn's finalizer.
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
    }): Promise<WaitResult> {
        const caller = this.getRecordByPath(args.caller)
        if (!caller) throw new AgentNotFoundError(args.caller as string)
        const clamped = clampWaitTimeout(this.config, args.timeoutMs)
        if (clamped.rejected) throw new Error(clamped.rejected)
        // Lost-wakeup protection: check authoritative state before subscribing.
        if ((this.mailboxes.get(caller.id) ?? []).length > 0) {
            return {
                message: withNote(WAIT_COMPLETED, clamped.note),
                timedOut: false,
            }
        }
        return await new Promise<WaitResult>((resolve) => {
            const timer = setTimeout(() => {
                cleanup()
                resolve({
                    message: withNote(WAIT_TIMED_OUT, clamped.note),
                    timedOut: true,
                })
            }, clamped.effectiveMs)
            const onMail = () => {
                cleanup()
                resolve({
                    message: withNote(WAIT_COMPLETED, clamped.note),
                    timedOut: false,
                })
            }
            const onSteer = () => {
                cleanup()
                resolve({
                    message: withNote(WAIT_INTERRUPTED, clamped.note),
                    timedOut: false,
                })
            }
            const cleanup = () => {
                clearTimeout(timer)
                this.waiters.get(caller.id)?.delete(onMail)
                this.steerWaiters.get(caller.id)?.delete(onSteer)
            }
            let set = this.waiters.get(caller.id)
            if (!set) {
                set = new Set()
                this.waiters.set(caller.id, set)
            }
            set.add(onMail)
            let steer = this.steerWaiters.get(caller.id)
            if (!steer) {
                steer = new Set()
                this.steerWaiters.set(caller.id, steer)
            }
            steer.add(onSteer)
            // Re-check after subscribing (message arriving in the race window).
            if ((this.mailboxes.get(caller.id) ?? []).length > 0) onMail()
        })
    }

    /** Wake a wait with "interrupted by new input" (steering hook). */
    notifySteer(path: AgentPath): void {
        const id = this.pathIndex.get(path as string)
        if (!id) return
        for (const fn of [...(this.steerWaiters.get(id) ?? [])]) {
            try {
                fn()
            } catch {
                // Ignore listener failures.
            }
        }
    }

    /** Drain one agent's mailbox (FIFO); used at model request boundaries. */
    drainMailbox(path: AgentPath): InterAgentCommunication[] {
        const id = this.pathIndex.get(path as string)
        if (!id) return []
        const queue = this.mailboxes.get(id) ?? []
        this.mailboxes.set(id, [])
        for (const comm of queue) {
            this.emit({
                _tag: 'CommunicationDelivered',
                communicationId: comm.id,
            })
        }
        return queue
    }

    /** Render queued mail as model-visible text without consuming it. */
    peekMailboxText(path: AgentPath): string[] {
        const id = this.pathIndex.get(path as string)
        if (!id) return []
        return (this.mailboxes.get(id) ?? []).map((comm) =>
            renderCommunicationText(comm)
        )
    }

    async shutdown(): Promise<void> {
        this.shutdownFlag = true
        for (const runtime of this.runtimes.values()) {
            runtime.abortController?.abort()
        }
        const turns = [...this.runtimes.values()].map(
            (r) => r.turnPromise?.catch(() => undefined) ?? Promise.resolve()
        )
        await Promise.all(turns)
        // Capture final usage before the live sessions disappear.
        await Promise.all(
            [...this.runtimes.keys()].map((id) => this.captureUsage(id))
        )
        for (const [, runtime] of [...this.runtimes]) {
            try {
                await this.host.closeSession(runtime.session)
            } catch {
                // Best-effort teardown.
            }
        }
        this.runtimes.clear()
        this.usageBaselines.clear()
        for (const set of this.waiters.values()) set.clear()
        for (const set of this.steerWaiters.values()) set.clear()
    }

    /** Serialize logical state for cold resume (no live handles). */
    serialize(rootSessionId: string): PersistedMultiAgentState {
        return {
            version: 1,
            rootSessionId,
            agents: [...this.records.values()]
                .filter((r) => r.path !== ('/root' as AgentPath))
                .map((r) => ({
                    id: r.id,
                    path: r.path,
                    parentId: r.parentId,
                    model: r.model,
                    role: r.role,
                    reasoningEffort: r.reasoningEffort,
                    statusTag: r.status._tag,
                    statusMessage:
                        r.status._tag === 'Completed'
                            ? (r.status.message ?? undefined)
                            : r.status._tag === 'Errored'
                              ? r.status.error
                              : undefined,
                    createdAt: r.createdAt,
                    lastActivityAt: r.lastActivityAt,
                    ...(r.usage ? { usage: r.usage } : {}),
                })),
        }
    }

    /** Restore logical identities without eager loading (lazy reload). */
    restore(state: PersistedMultiAgentState): void {
        if (state.version !== 1)
            throw new Error('unsupported persisted version')
        for (const persisted of state.agents) {
            if (this.pathIndex.has(persisted.path as string)) continue
            const path = parseAgentPath(persisted.path as string)
            const status = persistedStatus(persisted)
            const record: AgentRecord = {
                id: persisted.id as AgentId,
                path,
                parentId: (persisted.parentId ?? null) as AgentId | null,
                parentPath: parentAgentPath(path),
                status,
                residency: 'unloaded',
                role: persisted.role,
                model: persisted.model,
                reasoningEffort: persisted.reasoningEffort,
                createdAt: persisted.createdAt,
                lastActivityAt: persisted.lastActivityAt,
                ...(persisted.usage ? { usage: persisted.usage } : {}),
            }
            if (record.usage) this.usageTotals.set(record.id, record.usage)
            this.records.set(record.id, record)
            this.pathIndex.set(path as string, record.id)
            this.mailboxes.set(record.id, [])
        }
    }

    // --- Internals -----------------------------------------------------------

    private setRecord(
        id: AgentId,
        f: (prev: AgentRecord) => AgentRecord
    ): void {
        const prev = this.records.get(id)
        if (!prev) return
        const next = f(prev)
        this.records.set(id, {
            ...next,
            lastActivityAt: Date.now(),
        })
        if (prev.status._tag !== next.status._tag) {
            this.emit({
                _tag: 'StatusChanged',
                agentId: id,
                previous: prev.status,
                current: next.status,
            })
        }
    }

    private enqueueTo(id: AgentId, comm: InterAgentCommunication): void {
        const queue = this.mailboxes.get(id) ?? []
        queue.push(comm)
        this.mailboxes.set(id, queue)
        this.emit({ _tag: 'CommunicationEnqueued', communication: comm })
        for (const fn of [...(this.waiters.get(id) ?? [])]) {
            try {
                fn()
            } catch {
                // Ignore listener failures.
            }
        }
    }

    private touch(id: AgentId): void {
        const runtime = this.runtimes.get(id)
        if (runtime) runtime.lastTouched = Date.now()
    }

    /**
     * Fold one session's cumulative usage into the agent totals.
     * Total: never rejects; usage reporting must not break turns,
     * eviction, or shutdown.
     */
    private async captureUsage(id: AgentId): Promise<void> {
        try {
            const runtime = this.runtimes.get(id)
            if (!runtime) return
            const cumulative = await this.host.getUsage(runtime.session)
            const delta = subtractSessionUsage(
                cumulative,
                this.usageBaselines.get(runtime.session.handleId)
            )
            this.usageBaselines.set(runtime.session.handleId, cumulative)
            const next = addUsageDelta(this.usageTotals.get(id), {
                provider: delta.provider,
                modelId: delta.modelId,
                input: delta.input,
                output: delta.output,
                cacheRead: delta.cacheRead,
                cacheWrite: delta.cacheWrite,
                cost: delta.cost,
                userMessages: delta.userMessages,
                assistantMessages: delta.assistantMessages,
                toolResults: delta.toolResults,
                toolCalls: delta.toolCalls,
            })
            this.usageTotals.set(id, next)
            this.setRecord(id, (prev) => ({ ...prev, usage: next }))
        } catch {
            // Best-effort only.
        }
    }

    private async ensureLoaded(id: AgentId): Promise<RuntimeEntry> {
        const existing = this.runtimes.get(id)
        if (existing) {
            this.touch(id)
            return existing
        }
        const record = this.records.get(id)
        if (!record) throw new AgentNotFoundError(id as string)
        this.setRecord(id, (prev) => ({ ...prev, residency: 'loading' }))
        try {
            await this.evictOneIfRequired(id)
            const session = await this.host.createSession({
                agentPath: record.path,
                fork: { _tag: 'None' },
                parentHistory: [],
                model: record.model,
                role: record.role,
            })
            const entry: RuntimeEntry = {
                session,
                sessionIdBinding: null,
                abortController: null,
                running: false,
                turnPromise: null,
                lastTouched: Date.now(),
            }
            this.runtimes.set(id, entry)
            this.setRecord(id, (prev) => ({ ...prev, residency: 'loaded' }))
            this.emit({
                _tag: 'ResidencyChanged',
                agentId: id,
                residency: 'loaded',
            })
            return entry
        } catch (error) {
            this.setRecord(id, (prev) => ({ ...prev, residency: 'unloaded' }))
            throw error
        }
    }

    private async evictOneIfRequired(exceptId: AgentId): Promise<void> {
        if (this.runtimes.size < this.config.maxResidentAgents) return
        const candidates = [...this.records.values()].filter((record) => {
            if (record.id === exceptId) return false
            if (record.path === ('/root' as AgentPath)) return false
            const runtime = this.runtimes.get(record.id)
            if (!runtime || runtime.running) return false
            if ((this.mailboxes.get(record.id) ?? []).length > 0) return false
            return (
                record.status._tag === 'Completed' ||
                record.status._tag === 'Interrupted' ||
                record.status._tag === 'Errored' ||
                record.status._tag === 'PendingInit'
            )
        })
        candidates.sort((a, b) => {
            const ra = this.runtimes.get(a.id)?.lastTouched ?? 0
            const rb = this.runtimes.get(b.id)?.lastTouched ?? 0
            return ra - rb
        })
        const victim = candidates[0]
        if (!victim) return
        const runtime = this.runtimes.get(victim.id)
        if (runtime) {
            // Totals stay on the logical record; only the live baseline goes.
            await this.captureUsage(victim.id)
            try {
                await this.host.closeSession(runtime.session)
            } catch {
                // Best-effort eviction.
            }
            this.usageBaselines.delete(runtime.session.handleId)
            this.runtimes.delete(victim.id)
        }
        this.setRecord(victim.id, (prev) => ({
            ...prev,
            residency: 'unloaded',
        }))
        this.emit({
            _tag: 'ResidencyChanged',
            agentId: victim.id,
            residency: 'unloaded',
        })
    }

    private startTurn(id: AgentId, input: string): Promise<void> {
        const record = this.records.get(id)
        const runtime = this.runtimes.get(id)
        if (!record || !runtime || runtime.running) return Promise.resolve()
        const controller = new AbortController()
        runtime.abortController = controller
        runtime.running = true
        this.setRecord(id, () => ({ ...record, status: AgentStatus.running() }))
        const parentPath = record.parentPath

        const work = (async () => {
            try {
                // Drain trigger-turn mail into one model input at the boundary.
                const queued = this.mailboxes.get(id) ?? []
                this.mailboxes.set(id, [])
                for (const comm of queued) {
                    this.emit({
                        _tag: 'CommunicationDelivered',
                        communicationId: comm.id,
                    })
                }
                const parts =
                    queued.length > 0
                        ? [
                              ...queued.map((c) => renderCommunicationText(c)),
                              input,
                          ]
                        : [input]
                const result = await this.host.runTurn(
                    runtime.session,
                    parts.join('\n\n'),
                    controller.signal
                )
                const completed = AgentStatus.completed(result.lastMessage)
                this.setRecord(id, (prev) => ({ ...prev, status: completed }))
                const payload = formatFinalAnswer(completed)
                if (payload !== null && parentPath) {
                    const parentId = this.pathIndex.get(parentPath as string)
                    if (parentId) {
                        this.enqueueTo(
                            parentId,
                            finalAnswerCommunication({
                                author: record.path,
                                recipient: parentPath,
                                payload,
                            })
                        )
                    }
                }
                const turn = record.initiatingTurnId ?? 'turn-unknown'
                this.emit({
                    _tag: 'ActivityCompleted',
                    agentId: id,
                    agentPath: record.path,
                    parentTurnId: turn as unknown as import('./ids.ts').TurnId,
                })
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                if (
                    controller.signal.aborted ||
                    message === 'Aborted' ||
                    /abort/i.test(message)
                ) {
                    this.setRecord(id, (prev) => ({
                        ...prev,
                        status: AgentStatus.interrupted(),
                    }))
                } else {
                    const errored = AgentStatus.errored(message)
                    this.setRecord(id, (prev) => ({ ...prev, status: errored }))
                    const payload = formatFinalAnswer(errored)
                    if (payload !== null && parentPath) {
                        const parentId = this.pathIndex.get(
                            parentPath as string
                        )
                        if (parentId) {
                            this.enqueueTo(
                                parentId,
                                finalAnswerCommunication({
                                    author: record.path,
                                    recipient: parentPath,
                                    payload,
                                })
                            )
                        }
                    }
                }
            }
            // Best-effort usage capture: totals survive eviction, reload,
            // and shutdown even though live sessions do not.
            try {
                await this.captureUsage(id)
            } catch {
                // Usage reporting must never fail a turn.
            } finally {
                runtime.running = false
                runtime.abortController = null
                runtime.lastTouched = Date.now()
                // Scoped permit release: exactly once per admitted turn.
                this.activeTurns.delete(id)
            }
        })()
        runtime.turnPromise = work
        return work
    }
}

function selectHistory(
    parentHistory: readonly string[],
    fork: ForkTurns
): string[] {
    switch (fork._tag) {
        case 'All':
            return [...parentHistory]
        case 'None':
            return []
        case 'LastN':
            return parentHistory.slice(
                Math.max(0, parentHistory.length - fork.turns)
            )
    }
}

function withNote(message: string, note: string | null): string {
    return note ? `${message} ${note}` : message
}

export interface PersistedAgentSnapshot {
    readonly id: string
    readonly path: string
    readonly parentId: string | null
    readonly model: string
    readonly role?: string
    readonly reasoningEffort?: string
    readonly statusTag: string
    readonly statusMessage?: string
    readonly createdAt: number
    readonly lastActivityAt: number
    readonly usage?: AgentUsageTotals
}

export interface PersistedMultiAgentState {
    readonly version: 1
    readonly rootSessionId: string
    readonly agents: readonly PersistedAgentSnapshot[]
}

function persistedStatus(
    persisted: PersistedAgentSnapshot
): AgentRecord['status'] {
    switch (persisted.statusTag) {
        case 'Completed':
            return AgentStatus.completed(persisted.statusMessage ?? null)
        case 'Errored':
            return AgentStatus.errored(
                persisted.statusMessage ?? 'unknown error'
            )
        case 'Interrupted':
            return AgentStatus.interrupted()
        case 'Running':
            // A turn cannot survive a cold restart; reload as interrupted so a
            // later followup_task can start fresh work on the same identity.
            return AgentStatus.interrupted()
        case 'Shutdown':
            return AgentStatus.shutdown()
        case 'NotFound':
            return AgentStatus.notFound()
        default:
            return AgentStatus.pendingInit()
    }
}
