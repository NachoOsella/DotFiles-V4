import { readFile, stat } from 'node:fs/promises'
import { Data, Effect } from 'effect'
import {
    SUBAGENTS_STATE_CUSTOM_TYPE,
    findLatestState,
    type PersistedState,
} from '../subagents/src/persistence/session-state.ts'
import { mergeSessionStats } from './aggregate.ts'
import { buildStatsFromSnapshotData } from './subagent-snapshot.ts'
import {
    createEmptyStats,
    parseSessionUsage,
    type ModelPricingResolver,
    type SessionEntryLike,
    type SessionStats,
} from '../shared/usage.ts'

/** Identifies a session file that could not be read. */
export class SessionReadError extends Data.TaggedError('SessionReadError')<{
    readonly path: string
    readonly cause: unknown
}> {}

interface CachedSessionStats {
    readonly modifiedMs: number
    readonly size: number
    readonly pricing?: ModelPricingResolver
    readonly stats: SessionStats
    readonly snapshot?: PersistedState
}

const sessionStatsCache = new Map<string, CachedSessionStats>()

/** Parse a persisted JSONL session as a composable Effect. */
export function parseSessionFileEffect(
    filePath: string,
    pricing?: ModelPricingResolver,
    includeSubagents = true
): Effect.Effect<SessionStats, SessionReadError> {
    return Effect.tryPromise({
        try: async () => {
            const fileStats = await stat(filePath)
            let cached = sessionStatsCache.get(filePath)
            if (
                !cached ||
                cached.modifiedMs !== fileStats.mtimeMs ||
                cached.size !== fileStats.size ||
                cached.pricing !== pricing
            ) {
                const content = await readFile(filePath, 'utf8')
                cached = {
                    modifiedMs: fileStats.mtimeMs,
                    size: fileStats.size,
                    pricing,
                    ...parseSessionText(content, filePath, pricing),
                }
                sessionStatsCache.set(filePath, cached)
            }
            if (!includeSubagents || !cached.snapshot) return cached.stats
            // Cache only the root transcript; children can change while it is idle.
            const agents = await loadSubagentStats(
                cached.snapshot,
                filePath,
                pricing
            )
            return {
                ...cached.stats,
                ...mergeSessionStats(
                    [cached.stats, ...agents],
                    filePath,
                    cached.stats.name
                ),
                subagents: agents,
            }
        },
        catch: (cause) => new SessionReadError({ path: filePath, cause }),
    })
}

/** Promise adapter retained for callers outside an Effect pipeline. */
export function parseSessionFile(
    filePath: string,
    pricing?: ModelPricingResolver
): Promise<SessionStats> {
    return Effect.runPromise(parseSessionFileEffect(filePath, pricing))
}

/**
 * Parse in-memory session history for the current branch view.
 *
 * Usage accumulation itself lives in `shared/usage`; this wrapper only keeps
 * the historical name used by the stats command.
 */
export function parseCurrentBranch(
    entries: readonly SessionEntryLike[],
    file: string,
    name?: string,
    pricing?: ModelPricingResolver
): SessionStats {
    return parseSessionUsage(entries, file, name, pricing)
}

interface ParsedFile {
    readonly stats: SessionStats
    readonly snapshot?: PersistedState
}

function parseSessionText(
    content: string,
    filePath: string,
    pricing?: ModelPricingResolver
): ParsedFile {
    const entries: SessionEntryLike[] = []
    const snapshots: SessionEntryLike[] = []
    const headers = createEmptyStats(filePath)

    for (const line of content.split(/\r?\n/)) {
        const entry = parseEntry(line)
        if (!entry) continue
        if (entry.type === 'session_info' && typeof entry.name === 'string') {
            headers.name = entry.name
        }
        if (entry.type === 'session') {
            if (typeof entry.cwd === 'string') headers.project = entry.cwd
            if (typeof entry.parentSession === 'string') {
                headers.parentSessionPath = entry.parentSession
            }
        } else if (
            entry.type === 'custom' &&
            entry.customType === SUBAGENTS_STATE_CUSTOM_TYPE
        ) {
            snapshots.push(entry)
        }
        entries.push(entry)
    }

    // parseSessionUsage drops the imported fork prefix at the ownership marker.
    const parsed = parseSessionUsage(entries, filePath, undefined, pricing)
    const stats: SessionStats = {
        ...parsed,
        project: headers.project ?? parsed.project,
        name: headers.name ?? parsed.name,
        parentSessionPath:
            headers.parentSessionPath ?? parsed.parentSessionPath,
    }
    const snapshot = findLatestState(snapshots)
    return snapshot === undefined ? { stats } : { stats, snapshot }
}

/** Resolve each logical child once, preferring its transcript over aggregate fallback data. */
export async function loadSubagentStats(
    snapshot: PersistedState | undefined,
    file: string,
    pricing?: ModelPricingResolver
): Promise<SessionStats[]> {
    if (!snapshot) return []
    const fallback = new Map(
        buildStatsFromSnapshotData(snapshot, file, pricing).map((stats) => [
            stats.name,
            stats,
        ])
    )
    const result: SessionStats[] = []
    // Sequential children keep aggregate scans inside the caller's read concurrency limit.
    for (const agent of snapshot.agents) {
        let stats = fallback.get(agent.path)
        if (agent.sessionFile && agent.sessionFile !== file) {
            try {
                const transcript = await Effect.runPromise(
                    parseSessionFileEffect(agent.sessionFile, pricing, false)
                )
                if (
                    !stats ||
                    transcript.totalTokens.totalTokens >=
                        stats.totalTokens.totalTokens
                ) {
                    stats = transcript
                }
            } catch {
                // Missing, evicted, or unreadable files retain their last reported usage.
            }
        }
        result.push({
            ...(stats ?? createEmptyStats(agent.sessionFile ?? file)),
            name: agent.path,
            agentPath: agent.path,
            parentSessionPath: file,
        })
    }
    return result
}

function parseEntry(line: string): SessionEntryLike | undefined {
    if (!line.trim()) return undefined
    try {
        const value: unknown = JSON.parse(line)
        return isRecord(value) ? value : undefined
    } catch {
        return undefined
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}
