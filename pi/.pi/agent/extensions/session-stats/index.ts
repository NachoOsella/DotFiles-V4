/** Session statistics command backed by bounded, fault-tolerant Effect pipelines. */

import { resolve } from 'node:path'
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { matchesKey } from '@earendil-works/pi-tui'
import { Effect } from 'effect'
import { showStatsModal } from './modal.ts'
import { createModelPricingResolver } from '../shared/usage.ts'
import { mergeSessionStats } from './aggregate.ts'
import {
    SUBAGENTS_INFO_CHANNEL,
    isSubagentInfoState,
} from '../shared/dashboard-state.ts'
import {
    findLatestState,
    parsePersistedState,
    type PersistedState,
} from '../subagents/src/persistence/session-state.ts'
import { discoverSessionFiles } from './discovery.ts'
import {
    buildAllStatsOutput,
    buildCurrentSessionOutput,
    buildProjectStatsOutput,
    buildProjectSummaries,
    type DataQuality,
} from './output.ts'
import {
    parseCurrentBranch,
    parseSessionFileEffect,
    loadSubagentStats,
} from './parser.ts'
import type { SessionEntryLike, SessionStats } from '../shared/usage.ts'

const STATUS_KEY = 'session-stats'
const MAX_CONCURRENT_READS = 16
/** Register `/stats` for current-session and aggregate usage statistics. */
export default function sessionStatsExtension(pi: ExtensionAPI) {
    let liveSnapshot: PersistedState | undefined
    const stopUsage = pi.events.on(SUBAGENTS_INFO_CHANNEL, (value) => {
        if (isSubagentInfoState(value))
            liveSnapshot = parsePersistedState(value.snapshot)
    })
    pi.on('session_start', () => {
        liveSnapshot = undefined
    })
    pi.on('session_shutdown', () => {
        liveSnapshot = undefined
        stopUsage()
    })
    pi.registerCommand('stats', {
        description:
            'Show session statistics. /stats | /stats all [project] [days]',
        handler: async (args, ctx) => {
            const parsed = parseCommand(args)
            if (parsed.kind === 'invalid') {
                ctx.ui.notify(parsed.message, 'warning')
                return
            }
            if (parsed.kind === 'all') {
                await showAllSessionStats(parsed.days, parsed.project, ctx)
                return
            }
            await showCurrentSessionStats(ctx, liveSnapshot)
        },
    })
}

async function showAllSessionStats(
    days: number | undefined,
    project: boolean,
    ctx: ExtensionCommandContext
): Promise<void> {
    const program = Effect.gen(function* () {
        const discovered = yield* Effect.tryPromise(() =>
            discoverSessionFiles()
        )
        const projectSessions = project
            ? discovered.filter(
                  (session) =>
                      session.cwd && resolve(session.cwd) === resolve(ctx.cwd)
              )
            : discovered
        const cutoff = days
            ? Date.now() - days * 24 * 60 * 60 * 1000
            : undefined
        const sessions =
            cutoff === undefined
                ? projectSessions
                : projectSessions.filter(
                      (session) =>
                          session.created && session.created.getTime() >= cutoff
                  )
        if (sessions.length === 0) return { kind: 'empty' as const }

        yield* Effect.sync(() => {
            if (ctx.hasUI)
                ctx.ui.setStatus(
                    STATUS_KEY,
                    `Parsing ${sessions.length} sessions...`
                )
        })

        const pricing = createModelPricingResolver(ctx)
        const parsed = yield* Effect.forEach(
            sessions,
            (session) =>
                parseSessionFileEffect(session.path, pricing).pipe(
                    Effect.map((stats): SessionStats => {
                        const name = session.name || stats.name
                        return {
                            ...stats,
                            ...(name ? { name } : {}),
                            project: session.cwd || undefined,
                            parentSessionPath:
                                session.parentSessionPath ??
                                stats.parentSessionPath,
                        }
                    }),
                    Effect.catch(() => Effect.succeed(undefined))
                ),
            { concurrency: MAX_CONCURRENT_READS }
        )

        const parsedStats = parsed.flatMap((value) => (value ? [value] : []))
        const includedChildren = new Set(
            parsedStats.flatMap((root) =>
                (root.subagents ?? [])
                    .filter((child) => child.file !== root.file)
                    .map((child) => child.file)
            )
        )
        const stats = parsedStats.filter(
            (session) => !includedChildren.has(session.file)
        )
        return stats.length === 0
            ? { kind: 'unparseable' as const }
            : {
                  kind: 'success' as const,
                  stats,
                  quality: {
                      parsedSessions: parsedStats.length,
                      discoveredSessions: sessions.length,
                  } satisfies DataQuality,
              }
    }).pipe(
        Effect.ensuring(
            Effect.sync(() => {
                if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
            })
        )
    )

    try {
        const result = await Effect.runPromise(program)
        if (result.kind === 'empty') {
            ctx.ui.notify('No sessions found.', 'info')
            return
        }
        if (result.kind === 'unparseable') {
            ctx.ui.notify('No parseable sessions found.', 'warning')
            return
        }
        if (project) {
            await showStatsModal(
                (width, theme) =>
                    buildAllStatsOutput(
                        result.stats,
                        days,
                        width,
                        theme,
                        true,
                        undefined,
                        result.quality
                    ),
                ctx
            )
            return
        }

        await showAllStatsBrowser(result.stats, days, result.quality, ctx)
    } catch (error) {
        ctx.ui.notify(
            `Unable to load session statistics: ${errorMessage(error)}`,
            'error'
        )
    }
}

async function showAllStatsBrowser(
    sessions: readonly SessionStats[],
    days: number | undefined,
    quality: DataQuality,
    ctx: ExtensionCommandContext
): Promise<void> {
    type View = 'overview' | 'projects' | 'detail'
    let view: View = 'overview'
    let selectedProject = 0

    await showStatsModal(
        (width, theme) => {
            if (view === 'overview') {
                return buildAllStatsOutput(
                    sessions,
                    days,
                    width,
                    theme,
                    false,
                    undefined,
                    quality
                )
            }

            const projects = buildProjectSummaries(sessions, days)
            if (view === 'projects') {
                return buildProjectStatsOutput(
                    sessions,
                    days,
                    width,
                    theme,
                    selectedProject,
                    quality
                )
            }

            const selected = projects[selectedProject]
            return selected
                ? buildAllStatsOutput(
                      selected.sessions,
                      days,
                      width,
                      theme,
                      true,
                      selected.project,
                      quality
                  )
                : 'No project selected.'
        },
        ctx,
        (data) => {
            if (view === 'overview') {
                if (data.toLowerCase() === 'p') {
                    view = 'projects'
                    return true
                }
                return false
            }

            if (view === 'projects') {
                if (matchesKey(data, 'escape')) {
                    view = 'overview'
                    return true
                }
                if (data === 'j') {
                    selectedProject = Math.min(
                        selectedProject + 1,
                        Math.max(
                            0,
                            buildProjectSummaries(sessions, days).length - 1
                        )
                    )
                    return true
                }
                if (data === 'k') {
                    selectedProject = Math.max(0, selectedProject - 1)
                    return true
                }
                if (data === 'g') {
                    selectedProject = 0
                    return true
                }
                if (data === 'G') {
                    selectedProject = Math.max(
                        0,
                        buildProjectSummaries(sessions, days).length - 1
                    )
                    return true
                }
                if (matchesKey(data, 'enter')) {
                    view = 'detail'
                    return true
                }
                return false
            }

            if (matchesKey(data, 'escape')) {
                view = 'projects'
                return true
            }
            return false
        }
    )
}

async function showCurrentSessionStats(
    ctx: ExtensionCommandContext,
    liveSnapshot?: PersistedState
): Promise<void> {
    const currentFile = ctx.sessionManager.getSessionFile() ?? 'ephemeral'
    const pricing = createModelPricingResolver(ctx)
    const entries = ctx.sessionManager.getEntries() as SessionEntryLike[]
    const currentStats = parseCurrentBranch(
        entries,
        currentFile,
        ctx.sessionManager.getSessionName() ?? undefined,
        pricing
    )
    const rootSessionId = ctx.sessionManager.getSessionId()
    const latest = findLatestState(entries)
    const persisted =
        latest?.rootSessionId === rootSessionId ? latest : undefined
    const snapshot =
        liveSnapshot?.rootSessionId === rootSessionId &&
        liveSnapshot.persistedAt >= (persisted?.persistedAt ?? 0)
            ? liveSnapshot
            : persisted
    const agents = await loadSubagentStats(snapshot, currentFile, pricing)
    const snapshotAgeMs = snapshot?.persistedAt
        ? Math.max(0, Date.now() - snapshot.persistedAt)
        : undefined
    const stats = mergeSessionStats(
        [currentStats, ...agents],
        currentFile,
        currentStats.name
    )

    await showStatsModal(
        (width, theme) =>
            buildCurrentSessionOutput(stats, width, theme, {
                mainThread: currentStats,
                subagents: agents,
                snapshotAgeMs,
                contextUsage:
                    typeof ctx.getContextUsage === 'function'
                        ? ctx.getContextUsage()
                        : undefined,
            }),
        ctx
    )
}

type ParsedCommand =
    | { readonly kind: 'current' }
    | {
          readonly kind: 'all'
          readonly days?: number
          readonly project: boolean
      }
    | { readonly kind: 'invalid'; readonly message: string }

function parseCommand(args: string): ParsedCommand {
    const parts = args.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return { kind: 'current' }
    if (parts[0]?.toLowerCase() !== 'all' || parts.length > 3) {
        return {
            kind: 'invalid',
            message: 'Usage: /stats | /stats all [project] [days]',
        }
    }
    if (parts.length === 1) return { kind: 'all', project: false }

    const hasProjectFilter = parts[1]?.toLowerCase() === 'project'
    if (hasProjectFilter && parts.length === 2) {
        return { kind: 'all', project: true }
    }
    if (hasProjectFilter && parts.length !== 3) {
        return {
            kind: 'invalid',
            message: 'Usage: /stats | /stats all [project] [days]',
        }
    }
    if (!hasProjectFilter && parts.length === 3) {
        return {
            kind: 'invalid',
            message: 'Usage: /stats | /stats all [project] [days]',
        }
    }

    const rawDays = hasProjectFilter ? parts[2] : parts[1]
    if (!rawDays || !/^\d+$/.test(rawDays)) {
        return { kind: 'invalid', message: 'Days must be a positive integer.' }
    }
    const days = Number(rawDays)
    if (!Number.isSafeInteger(days) || days < 1) {
        return { kind: 'invalid', message: 'Days must be a positive integer.' }
    }
    return { kind: 'all', days, project: hasProjectFilter }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
