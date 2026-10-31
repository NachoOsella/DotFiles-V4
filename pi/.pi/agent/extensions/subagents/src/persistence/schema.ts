import type { ModelUsage, PricingSource } from '../../../shared/usage.ts'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type {
    AgentBlockedInfo,
    AgentLimitReached,
    AgentUsageTotals,
    PendingCompletion,
    SessionToolCallCount,
} from '../domain/agent-record.ts'
import {
    isValidAgentPath,
    parentAgentPath,
    ROOT_PATH,
} from '../domain/agent-path.ts'
import type { FinalAnswerMeta } from '../domain/communication.ts'
import type { AgentPath, CommunicationId } from '../domain/ids.ts'
import type { ModelIdentity } from '../domain/parent-snapshot.ts'

export interface PersistedSubagentV2 {
    readonly id: string
    readonly path: string
    readonly parentPath: string | null
    readonly rootSessionId: string
    readonly sessionId?: string
    readonly sessionFile?: string
    readonly cwd?: string
    readonly role?: string
    readonly model: ModelIdentity
    readonly thinkingLevel?: ThinkingLevel
    readonly activeTools: readonly string[]
    readonly status: string
    readonly statusMessage?: string
    readonly createdAt: number
    readonly lastActivityAt: number
    readonly runSequence: number
    readonly lastDeliveredRunSequence?: number
    readonly pendingCompletions?: readonly PendingCompletion[]
    readonly limitReached?: AgentLimitReached
    readonly blocked?: AgentBlockedInfo
    readonly lastResult?: string
    readonly task?: string
    readonly usage?: AgentUsageTotals
}

export interface PersistedSubagentStateV2 {
    readonly version: 2
    readonly rootSessionId: string
    readonly persistedAt: number
    readonly agents: readonly PersistedSubagentV2[]
}

/** Task kind recorded on a version 3 snapshot. */
export type PersistedTaskKind = 'spawn' | 'followup'

/** Task lifecycle status recorded on a version 3 snapshot. */
export type PersistedTaskStatus = 'active' | 'completed' | 'failed' | 'archived'

/** Durable task assignment correlated with a communication and run. */
export interface PersistedTaskV3 {
    readonly id: string
    readonly agentPath: string
    readonly objective: string
    readonly kind: PersistedTaskKind
    readonly submittedBy: string
    readonly communicationId: string
    readonly runSequence?: number
    readonly status: PersistedTaskStatus
    readonly createdAt: number
    readonly completedAt?: number
    readonly resultRef?: string
}

/** Version 2 agent record plus the archive marker. */
export interface PersistedSubagentV3 extends PersistedSubagentV2 {
    readonly archivedAt?: number
}

export interface PersistedSubagentStateV3 {
    readonly version: 3
    readonly rootSessionId: string
    readonly persistedAt: number
    readonly agents: readonly PersistedSubagentV3[]
    readonly tasks: readonly PersistedTaskV3[]
}

/**
 * Deep-normalizing parser for V2 snapshots. Returns undefined only when the
 * envelope cannot be used at all. Malformed agent records are dropped and
 * recoverable fields are coerced so one bad record never discards the rest.
 */
export function parsePersistedStateV2(
    value: unknown
): PersistedSubagentStateV2 | undefined {
    return normalizePersistedStateV2(value)?.value
}

/** Strict guard: true only when normalization would make no repairs. */
export function isPersistedStateV2(
    value: unknown
): value is PersistedSubagentStateV2 {
    const normalized = normalizePersistedStateV2(value)
    return normalized !== undefined && !normalized.repaired
}

interface Normalized<T> {
    readonly value: T
    readonly repaired: boolean
}

function normalizePersistedStateV2(
    value: unknown
): Normalized<PersistedSubagentStateV2> | undefined {
    const raw = asRecord(value)
    if (
        raw === undefined ||
        raw.version !== 2 ||
        typeof raw.rootSessionId !== 'string' ||
        !Array.isArray(raw.agents)
    ) {
        return undefined
    }
    let repaired = false
    const persistedAt = finiteNumber(raw.persistedAt, 0)
    if (persistedAt !== raw.persistedAt) repaired = true

    const seenIds = new Set<string>()
    const seenPaths = new Set<string>()
    const agents: PersistedSubagentV2[] = []
    for (const candidate of raw.agents) {
        const parsed = normalizePersistedSubagentV2(
            candidate,
            raw.rootSessionId,
            persistedAt
        )
        if (parsed === undefined) {
            repaired = true
            continue
        }
        if (seenIds.has(parsed.value.id) || seenPaths.has(parsed.value.path)) {
            repaired = true
            continue
        }
        if (parsed.repaired) repaired = true
        seenIds.add(parsed.value.id)
        seenPaths.add(parsed.value.path)
        agents.push(parsed.value)
    }

    return {
        value: {
            version: 2,
            rootSessionId: raw.rootSessionId,
            persistedAt,
            agents,
        },
        repaired,
    }
}

/**
 * Deep-normalizing parser for V3 snapshots with the V2 repair philosophy:
 * drop records that cannot be addressed, coerce recoverable fields, and never
 * let one malformed record discard the rest. Duplicate agent identities and
 * task ids keep the first occurrence.
 */
export function parsePersistedStateV3(
    value: unknown
): PersistedSubagentStateV3 | undefined {
    return normalizePersistedStateV3(value)?.value
}

/** Strict guard: true only when V3 normalization would make no repairs. */
export function isPersistedStateV3(
    value: unknown
): value is PersistedSubagentStateV3 {
    const normalized = normalizePersistedStateV3(value)
    return normalized !== undefined && !normalized.repaired
}

/**
 * Migrate a parsed V2 snapshot to the V3 envelope.
 *
 * Version 2 stays readable indefinitely. Migration adds an empty task list and
 * no archive markers; the next checkpoint serializes real V3 state.
 */
export function migratePersistedStateV2ToV3(
    state: PersistedSubagentStateV2
): PersistedSubagentStateV3 {
    return {
        version: 3,
        rootSessionId: state.rootSessionId,
        persistedAt: state.persistedAt,
        agents: state.agents,
        tasks: [],
    }
}

function normalizePersistedStateV3(
    value: unknown
): Normalized<PersistedSubagentStateV3> | undefined {
    const raw = asRecord(value)
    if (
        raw === undefined ||
        raw.version !== 3 ||
        typeof raw.rootSessionId !== 'string' ||
        !Array.isArray(raw.agents)
    ) {
        return undefined
    }
    let repaired = false
    const persistedAt = finiteNumber(raw.persistedAt, 0)
    if (persistedAt !== raw.persistedAt) repaired = true

    const seenIds = new Set<string>()
    const seenPaths = new Set<string>()
    const agents: PersistedSubagentV3[] = []
    for (const candidate of raw.agents) {
        const parsed = normalizePersistedSubagentV3(
            candidate,
            raw.rootSessionId,
            persistedAt
        )
        if (parsed === undefined) {
            repaired = true
            continue
        }
        if (seenIds.has(parsed.value.id) || seenPaths.has(parsed.value.path)) {
            repaired = true
            continue
        }
        if (parsed.repaired) repaired = true
        seenIds.add(parsed.value.id)
        seenPaths.add(parsed.value.path)
        agents.push(parsed.value)
    }

    const tasks = normalizePersistedTasks(raw.tasks, persistedAt)
    if (tasks.repaired) repaired = true

    return {
        value: {
            version: 3,
            rootSessionId: raw.rootSessionId,
            persistedAt,
            agents,
            tasks: tasks.value,
        },
        repaired,
    }
}

function normalizePersistedSubagentV3(
    value: unknown,
    snapshotRootSessionId: string,
    fallbackTimestamp: number
): Normalized<PersistedSubagentV3> | undefined {
    const base = normalizePersistedSubagentV2(
        value,
        snapshotRootSessionId,
        fallbackTimestamp
    )
    if (base === undefined) return undefined
    const raw = asRecord(value)
    if (raw === undefined) return undefined

    let repaired = base.repaired
    let archivedAt: number | undefined
    if (raw.archivedAt !== undefined) {
        archivedAt = finiteNumber(raw.archivedAt, fallbackTimestamp)
        if (archivedAt !== raw.archivedAt) repaired = true
    }
    return {
        value: {
            ...base.value,
            ...(archivedAt !== undefined ? { archivedAt } : {}),
        },
        repaired,
    }
}

function normalizePersistedTasks(
    value: unknown,
    fallbackTimestamp: number
): Normalized<PersistedTaskV3[]> {
    if (!Array.isArray(value)) {
        // A V3 checkpoint always carries the list. Treat a missing or malformed
        // list as recoverable empty state, not as an unusable envelope.
        return { value: [], repaired: true }
    }
    let repaired = false
    const seenIds = new Set<string>()
    const tasks: PersistedTaskV3[] = []
    for (const candidate of value) {
        const parsed = normalizePersistedTask(candidate, fallbackTimestamp)
        if (parsed === undefined) {
            repaired = true
            continue
        }
        if (seenIds.has(parsed.value.id)) {
            repaired = true
            continue
        }
        if (parsed.repaired) repaired = true
        seenIds.add(parsed.value.id)
        tasks.push(parsed.value)
    }
    return { value: tasks, repaired }
}

function normalizePersistedTask(
    value: unknown,
    fallbackTimestamp: number
): Normalized<PersistedTaskV3> | undefined {
    const raw = asRecord(value)
    if (raw === undefined) return undefined
    const id = nonEmptyString(raw.id)
    const agentPath = parseChildPath(raw.agentPath)
    const objective = nonEmptyString(raw.objective)
    const submittedBy = parseCanonicalPath(raw.submittedBy)
    const communicationId = nonEmptyString(raw.communicationId)
    if (
        id === undefined ||
        agentPath === undefined ||
        objective === undefined ||
        submittedBy === undefined ||
        communicationId === undefined
    ) {
        return undefined
    }
    const kind = raw.kind
    if (kind !== 'spawn' && kind !== 'followup') return undefined
    const status = raw.status
    if (
        status !== 'active' &&
        status !== 'completed' &&
        status !== 'failed' &&
        status !== 'archived'
    ) {
        return undefined
    }

    let repaired = false
    const createdAt = finiteNumber(raw.createdAt, fallbackTimestamp)
    if (createdAt !== raw.createdAt) repaired = true

    let runSequence: number | undefined
    if (raw.runSequence !== undefined) {
        runSequence = finiteInteger(raw.runSequence, 0)
        if (runSequence !== raw.runSequence) repaired = true
    }
    let completedAt: number | undefined
    if (raw.completedAt !== undefined) {
        completedAt = finiteNumber(raw.completedAt, fallbackTimestamp)
        if (completedAt !== raw.completedAt) repaired = true
    }
    let resultRef: string | undefined
    if (raw.resultRef !== undefined) {
        resultRef = optionalString(raw.resultRef)
        if (resultRef === undefined) repaired = true
    }

    return {
        value: {
            id,
            agentPath,
            objective,
            kind,
            submittedBy,
            communicationId,
            status,
            createdAt,
            ...(runSequence !== undefined ? { runSequence } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
            ...(resultRef !== undefined ? { resultRef } : {}),
        },
        repaired,
    }
}

function normalizePersistedSubagentV2(
    value: unknown,
    snapshotRootSessionId: string,
    fallbackTimestamp: number
): Normalized<PersistedSubagentV2> | undefined {
    const raw = asRecord(value)
    if (raw === undefined) return undefined

    // Identity, path, and model are required: without them the record cannot
    // be addressed or loaded, so only this record is dropped.
    const id = nonEmptyString(raw.id)
    if (id === undefined) return undefined
    const path = parseChildPath(raw.path)
    if (path === undefined) return undefined
    const model = parseModelIdentity(raw.model)
    if (model === undefined) return undefined

    let repaired = false
    let rootSessionId = snapshotRootSessionId
    if (typeof raw.rootSessionId === 'string') {
        // A record bound to another root session is unrelated to this snapshot;
        // restoring it would carry a foreign root forward on the next serialize.
        if (raw.rootSessionId !== snapshotRootSessionId) return undefined
        rootSessionId = raw.rootSessionId
    } else {
        repaired = true
    }
    const parentPath = parentAgentPath(path)
    if (raw.parentPath !== parentPath) repaired = true

    let thinkingLevel: ThinkingLevel | undefined
    if (raw.thinkingLevel !== undefined) {
        thinkingLevel = parseThinkingLevel(raw.thinkingLevel)
        if (thinkingLevel === undefined) repaired = true
    }

    const activeTools = stringArray(raw.activeTools)
    if (
        !Array.isArray(raw.activeTools) ||
        activeTools.length !== raw.activeTools.length
    ) {
        repaired = true
    }

    const status = parseStatus(raw.status)
    if (status !== raw.status) repaired = true

    const createdAt = finiteNumber(raw.createdAt, fallbackTimestamp)
    if (createdAt !== raw.createdAt) repaired = true
    const lastActivityAt = finiteNumber(raw.lastActivityAt, fallbackTimestamp)
    if (lastActivityAt !== raw.lastActivityAt) repaired = true

    const runSequence = finiteInteger(raw.runSequence, 0)
    if (runSequence !== raw.runSequence) repaired = true

    let lastDeliveredRunSequence: number | undefined
    if (raw.lastDeliveredRunSequence !== undefined) {
        lastDeliveredRunSequence = finiteInteger(
            raw.lastDeliveredRunSequence,
            0
        )
        if (lastDeliveredRunSequence !== raw.lastDeliveredRunSequence) {
            repaired = true
        }
    }

    const pendingCompletions = normalizePendingCompletions(
        raw.pendingCompletions,
        path,
        parentPath,
        lastDeliveredRunSequence
    )
    if (pendingCompletions.repaired) repaired = true

    const limitReached = normalizeLimitReached(raw.limitReached)
    if (limitReached.repaired) repaired = true

    const blocked = normalizeBlocked(raw.blocked)
    if (blocked.repaired) repaired = true

    const usage = normalizeUsage(raw.usage)
    if (usage.repaired) repaired = true

    const sessionId = optionalString(raw.sessionId)
    const sessionFile = optionalString(raw.sessionFile)
    const cwd = optionalString(raw.cwd)
    const role = optionalString(raw.role)
    const statusMessage = optionalString(raw.statusMessage)
    const lastResult = optionalString(raw.lastResult)
    const task = optionalString(raw.task)
    for (const [rawValue, parsedValue] of [
        [raw.sessionId, sessionId],
        [raw.sessionFile, sessionFile],
        [raw.cwd, cwd],
        [raw.role, role],
        [raw.statusMessage, statusMessage],
        [raw.lastResult, lastResult],
        [raw.task, task],
    ] as const) {
        if (rawValue !== undefined && parsedValue === undefined) repaired = true
    }

    return {
        value: {
            id,
            path,
            parentPath,
            rootSessionId,
            model,
            activeTools,
            status,
            createdAt,
            lastActivityAt,
            runSequence,
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(sessionFile !== undefined ? { sessionFile } : {}),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(role !== undefined ? { role } : {}),
            ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(statusMessage !== undefined ? { statusMessage } : {}),
            ...(lastDeliveredRunSequence !== undefined
                ? { lastDeliveredRunSequence }
                : {}),
            ...(pendingCompletions.value !== undefined
                ? { pendingCompletions: pendingCompletions.value }
                : {}),
            ...(limitReached.value !== undefined
                ? { limitReached: limitReached.value }
                : {}),
            ...(blocked.value !== undefined ? { blocked: blocked.value } : {}),
            ...(lastResult !== undefined ? { lastResult } : {}),
            ...(task !== undefined ? { task } : {}),
            ...(usage.value !== undefined ? { usage: usage.value } : {}),
        },
        repaired,
    }
}

function normalizeBlocked(
    value: unknown
): Normalized<AgentBlockedInfo | undefined> {
    if (value === undefined) return { value: undefined, repaired: false }
    const raw = asRecord(value)
    const code = raw === undefined ? undefined : nonEmptyString(raw.code)
    const reason = raw === undefined ? undefined : nonEmptyString(raw.reason)
    if (raw === undefined || code === undefined || reason === undefined) {
        return { value: undefined, repaired: true }
    }
    return { value: { code, reason }, repaired: false }
}

function normalizeLimitReached(
    value: unknown
): Normalized<AgentLimitReached | undefined> {
    if (value === undefined) return { value: undefined, repaired: false }
    const raw = asRecord(value)
    const kind = raw?.kind
    const detail = raw === undefined ? undefined : nonEmptyString(raw.detail)
    if (
        raw === undefined ||
        detail === undefined ||
        (kind !== 'deadline' && kind !== 'requests' && kind !== 'tokens')
    ) {
        return { value: undefined, repaired: true }
    }
    return { value: { kind, detail }, repaired: false }
}

/**
 * Rebuild the durable completion outbox for one agent. Entries must belong to
 * this agent and its parent, carry a usable envelope, and not already be
 * acknowledged; duplicate ids or run sequences are dropped.
 */
function normalizePendingCompletions(
    value: unknown,
    agentPath: AgentPath,
    parentPath: AgentPath | null,
    acknowledgedRunSequence: number | undefined
): Normalized<PendingCompletion[] | undefined> {
    if (value === undefined) return { value: undefined, repaired: false }
    if (!Array.isArray(value)) return { value: undefined, repaired: true }
    let repaired = false
    const seenIds = new Set<string>()
    const seenSequences = new Set<number>()
    const completions: PendingCompletion[] = []
    for (const candidate of value) {
        const parsed = normalizePendingCompletion(
            candidate,
            agentPath,
            parentPath
        )
        if (parsed === undefined) {
            repaired = true
            continue
        }
        const completion = parsed.value
        if (
            seenIds.has(completion.communicationId) ||
            seenSequences.has(completion.runSequence) ||
            (acknowledgedRunSequence !== undefined &&
                completion.runSequence <= acknowledgedRunSequence)
        ) {
            repaired = true
            continue
        }
        if (parsed.repaired) repaired = true
        seenIds.add(completion.communicationId)
        seenSequences.add(completion.runSequence)
        completions.push(completion)
    }
    return { value: completions, repaired }
}

function normalizePendingCompletion(
    value: unknown,
    agentPath: AgentPath,
    parentPath: AgentPath | null
): Normalized<PendingCompletion> | undefined {
    const raw = asRecord(value)
    if (raw === undefined) return undefined
    const communicationId = nonEmptyString(raw.communicationId)
    const author = parseCanonicalPath(raw.author)
    const recipient = parseCanonicalPath(raw.recipient)
    const payload = typeof raw.payload === 'string' ? raw.payload : undefined
    if (
        communicationId === undefined ||
        author === undefined ||
        recipient === undefined ||
        payload === undefined ||
        author !== agentPath ||
        recipient !== parentPath
    ) {
        return undefined
    }
    let repaired = false
    const runSequence = finiteInteger(raw.runSequence, 0)
    if (runSequence !== raw.runSequence) repaired = true
    const meta = normalizeFinalAnswerMeta(raw.meta)
    if (meta.repaired) repaired = true
    return {
        value: {
            communicationId: communicationId as CommunicationId,
            runSequence,
            author,
            recipient,
            payload,
            ...(meta.value !== undefined ? { meta: meta.value } : {}),
        },
        repaired,
    }
}

function normalizeFinalAnswerMeta(
    value: unknown
): Normalized<FinalAnswerMeta | undefined> {
    if (value === undefined) return { value: undefined, repaired: false }
    const raw = asRecord(value)
    const model = raw === undefined ? undefined : nonEmptyString(raw.model)
    if (raw === undefined || model === undefined) {
        return { value: undefined, repaired: true }
    }
    let repaired = false
    const meta: {
        role?: string
        model: string
        durationMs?: number
        tokens?: number
        cost?: number
        failed?: boolean
        truncated?: boolean
        fullResultRef?: string
        taskId?: string
        runSequence?: number
    } = { model }
    const role = optionalString(raw.role)
    if (role !== undefined) meta.role = role
    else if (raw.role !== undefined) repaired = true
    if (raw.durationMs !== undefined) {
        meta.durationMs = finiteNumber(raw.durationMs, 0)
        if (meta.durationMs !== raw.durationMs) repaired = true
    }
    if (raw.tokens !== undefined) {
        meta.tokens = finiteNumber(raw.tokens, 0)
        if (meta.tokens !== raw.tokens) repaired = true
    }
    if (raw.cost !== undefined) {
        meta.cost = finiteNumber(raw.cost, 0)
        if (meta.cost !== raw.cost) repaired = true
    }
    if (raw.failed !== undefined) {
        if (typeof raw.failed === 'boolean') meta.failed = raw.failed
        else repaired = true
    }
    if (raw.truncated !== undefined) {
        if (typeof raw.truncated === 'boolean') meta.truncated = raw.truncated
        else repaired = true
    }
    if (raw.fullResultRef !== undefined) {
        const reference = nonEmptyString(raw.fullResultRef)
        if (reference !== undefined) meta.fullResultRef = reference
        else repaired = true
    }
    if (raw.taskId !== undefined) {
        const taskId = nonEmptyString(raw.taskId)
        if (taskId !== undefined) meta.taskId = taskId
        else repaired = true
    }
    if (raw.runSequence !== undefined) {
        if (
            typeof raw.runSequence === 'number' &&
            Number.isSafeInteger(raw.runSequence) &&
            raw.runSequence >= 0
        ) {
            meta.runSequence = raw.runSequence
        } else {
            // Do not invent run 0: losing correlation is safer than claiming it.
            repaired = true
        }
    }
    return { value: meta, repaired }
}

/**
 * Malformed usage is omitted rather than invented. Valid counters are kept,
 * with nonfinite values clamped to zero.
 */
function normalizeUsage(
    value: unknown
): Normalized<AgentUsageTotals | undefined> {
    if (value === undefined) return { value: undefined, repaired: false }
    const raw = asRecord(value)
    if (raw === undefined) return { value: undefined, repaired: true }
    if (typeof raw.provider !== 'string' || typeof raw.modelId !== 'string') {
        return { value: undefined, repaired: true }
    }
    let repaired = false
    const counter = (key: string): number => {
        const parsed = finiteNumber(raw[key], 0)
        if (parsed !== raw[key]) repaired = true
        return parsed
    }
    const toolCalls: SessionToolCallCount[] = []
    if (!Array.isArray(raw.toolCalls)) {
        // toolCalls is required on AgentUsageTotals; missing or malformed is a
        // repair, not a valid snapshot.
        repaired = true
    } else {
        for (const candidate of raw.toolCalls) {
            const call = asRecord(candidate)
            const name =
                call === undefined ? undefined : nonEmptyString(call.name)
            if (call === undefined || name === undefined) {
                repaired = true
                continue
            }
            const count = finiteInteger(call.count, 0)
            if (count !== call.count) repaired = true
            toolCalls.push({ name, count })
        }
    }
    const models = normalizeModels(raw.models)
    if (models.repaired) repaired = true
    return {
        value: {
            provider: raw.provider,
            modelId: raw.modelId,
            input: counter('input'),
            output: counter('output'),
            cacheRead: counter('cacheRead'),
            cacheWrite: counter('cacheWrite'),
            cost: counter('cost'),
            userMessages: counter('userMessages'),
            assistantMessages: counter('assistantMessages'),
            toolResults: counter('toolResults'),
            toolCalls,
            ...(models.value !== undefined ? { models: models.value } : {}),
        },
        repaired,
    }
}

/** Recover physical-model rows without inventing a model attribution. */
function normalizeModels(value: unknown): Normalized<ModelUsage[] | undefined> {
    if (value === undefined) return { value: undefined, repaired: false }
    if (!Array.isArray(value)) return { value: undefined, repaired: true }
    let repaired = false
    const models: ModelUsage[] = []
    const seen = new Set<string>()
    for (const candidate of value) {
        const raw = asRecord(candidate)
        const provider = raw && nonEmptyString(raw.provider)
        const modelId = raw && nonEmptyString(raw.modelId)
        if (
            !raw ||
            !provider ||
            !modelId ||
            seen.has(`${provider}/${modelId}`)
        ) {
            repaired = true
            continue
        }
        seen.add(`${provider}/${modelId}`)
        const counter = (key: string): number => {
            const parsed = finiteNumber(raw[key], 0)
            if (parsed !== raw[key]) repaired = true
            return parsed
        }
        const model: ModelUsage = {
            provider,
            modelId,
            count: counter('count'),
            input: counter('input'),
            output: counter('output'),
            cacheRead: counter('cacheRead'),
            cacheWrite: counter('cacheWrite'),
            cost: counter('cost'),
        }
        for (const key of [
            'reportedCost',
            'catalogCost',
            'estimatedCost',
            'unknownTokens',
            'pricedTokens',
        ] as const) {
            if (raw[key] !== undefined) model[key] = counter(key)
        }
        if (raw.pricingSource !== undefined) {
            if (
                typeof raw.pricingSource === 'string' &&
                [
                    'reported',
                    'catalog',
                    'estimated',
                    'unknown',
                    'mixed',
                ].includes(raw.pricingSource)
            ) {
                model.pricingSource = raw.pricingSource as PricingSource
            } else repaired = true
        }
        models.push(model)
    }
    return {
        value: models.length > 0 || value.length === 0 ? models : undefined,
        repaired,
    }
}

const THINKING_LEVELS: readonly string[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]

const STATUS_TAGS: readonly string[] = [
    'PendingInit',
    'Running',
    'Interrupted',
    'Completed',
    'Errored',
    'Shutdown',
    'NotFound',
]

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
    return typeof value === 'string' && THINKING_LEVELS.includes(value)
        ? (value as ThinkingLevel)
        : undefined
}

function parseStatus(value: unknown): string {
    return typeof value === 'string' && STATUS_TAGS.includes(value)
        ? value
        : 'PendingInit'
}

function parseModelIdentity(value: unknown): ModelIdentity | undefined {
    const raw = asRecord(value)
    if (raw === undefined) return undefined
    const provider = nonEmptyString(raw.provider)
    const id = nonEmptyString(raw.id)
    if (provider === undefined || id === undefined) return undefined
    return { provider, id }
}

/** Agent records never include the root identity. */
function parseChildPath(value: unknown): AgentPath | undefined {
    const path = parseCanonicalPath(value)
    return path === undefined || path === ROOT_PATH ? undefined : path
}

/** Communication endpoints may be root. */
function parseCanonicalPath(value: unknown): AgentPath | undefined {
    return typeof value === 'string' && isValidAgentPath(value)
        ? value
        : undefined
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function finiteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : fallback
}

function finiteInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : fallback
}
