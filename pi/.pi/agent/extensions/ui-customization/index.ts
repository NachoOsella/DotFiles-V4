import { homedir } from 'node:os'
import { relative } from 'node:path'
import type {
    ExtensionAPI,
    ExtensionContext,
    ReadonlyFooterDataProvider,
} from '@earendil-works/pi-coding-agent'
import {
    getCapabilities,
    hyperlink,
    truncateToWidth,
} from '@earendil-works/pi-tui'
import {
    DISCORD_ACTIVITY_CHANNEL,
    emptyGitInfoState,
    emptyModelInfoState,
    emptySubagentInfoState,
    GIT_INFO_CHANNEL,
    MODEL_INFO_CHANNEL,
    REFRESH_CHANNEL,
    SUBAGENTS_INFO_CHANNEL,
    isDiscordActivityState,
    isGitInfoState,
    isModelInfoState,
    isSubagentInfoState,
    sanitizeGitInfoState,
    sanitizeModelInfoState,
    sanitizeSubagentInfoState,
} from '../shared/dashboard-state.ts'
import {
    appendOverflowIndicator,
    columns,
    fitFooterSegments,
    normalizeWidth,
    packExtensionStatuses,
} from './src/dashboard-layout.ts'

function formatDirectory(cwd: string) {
    const home = homedir()
    if (cwd === home) return '~'
    if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`
    return cwd
}

export default function uiCustomization(pi: ExtensionAPI) {
    let title = 'pi'
    let modelInfo = emptyModelInfoState()
    let gitInfo = emptyGitInfoState()
    let subagentInfo = emptySubagentInfoState()
    let discordActivityActive = false
    let requestRender: (() => void) | undefined

    const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
        if (!isModelInfoState(value)) return
        // Finite-number sanitization at consumption: the shared validator
        // accepts legacy payloads as-is, so NaN/Infinity are rejected here.
        modelInfo = sanitizeModelInfoState(value)
        requestRender?.()
    })

    const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
        if (!isGitInfoState(value)) return
        gitInfo = sanitizeGitInfoState(value)
        requestRender?.()
    })

    const stopDiscordActivityListener = pi.events.on(
        DISCORD_ACTIVITY_CHANNEL,
        (value) => {
            if (!isDiscordActivityState(value)) return
            discordActivityActive = value.active
            requestRender?.()
        }
    )

    const stopSubagentListener = pi.events.on(
        SUBAGENTS_INFO_CHANNEL,
        (value) => {
            if (!isSubagentInfoState(value)) return
            subagentInfo = sanitizeSubagentInfoState(value)
            requestRender?.()
        }
    )

    function install(ctx: ExtensionContext) {
        if (ctx.mode !== 'tui') return

        // Resolved once per session: render must not do filesystem/process work.
        const formattedDirectory = formatDirectory(ctx.cwd)

        ctx.ui.setFooter(
            (tui, theme, footerData: ReadonlyFooterDataProvider) => {
                requestRender = () => tui.requestRender()

                return {
                    invalidate() {},
                    render(width: number) {
                        const safeWidth = normalizeWidth(width)
                        // `~` marks live streaming estimates; measured cadences render
                        // bare. Falls back to the generating flag for payloads that
                        // predate throughputIsEstimate.
                        const isEstimate =
                            modelInfo.throughputIsEstimate ??
                            modelInfo.generating
                        const fit = fitFooterSegments({
                            width: safeWidth,
                            directory: formattedDirectory,
                            provider: modelInfo.provider,
                            modelId: modelInfo.modelId,
                            thinking: modelInfo.thinking,
                            contextPercent: modelInfo.contextPercent,
                            contextWindow: modelInfo.contextWindow,
                            cost: modelInfo.cost,
                            tokensPerSecond: modelInfo.tokensPerSecond,
                            throughputIsEstimate: isEstimate,
                            subagentsRunning: subagentInfo.running,
                            branch: gitInfo.branch,
                            changedFiles: gitInfo.changedFiles,
                            pullRequestNumber:
                                gitInfo.pullRequest?.number ?? null,
                            // Forward-compatible freshness: git-info does not emit stale
                            // yet (follow-up on the producer side); absent means fresh.
                            gitStale: gitInfo.stale,
                        })

                        const directory = theme.fg('text', fit.row1Left)
                        // Reattach the PR hyperlink when the PR segment survived
                        // degradation. The fitted label carries the exact `PR #N` text.
                        let gitDisplay = fit.row2Right
                        if (
                            !fit.dropped.includes('pr') &&
                            gitInfo.pullRequest
                        ) {
                            const prLabel = `PR #${gitInfo.pullRequest.number}`
                            const linkedPr = getCapabilities().hyperlinks
                                ? hyperlink(prLabel, gitInfo.pullRequest.url)
                                : prLabel
                            gitDisplay = gitDisplay.replace(prLabel, linkedPr)
                        }

                        // Active-work indicator takes priority over truncation; columns()
                        // truncates only as a last resort.
                        let modelStatus = theme.fg('muted', fit.row1Right)
                        if (discordActivityActive) {
                            modelStatus += ` ${theme.fg('borderAccent', '●')}`
                        }

                        const lines = [
                            columns(directory, modelStatus, safeWidth),
                            columns(
                                theme.fg('muted', fit.row2Left),
                                theme.fg('muted', gitDisplay),
                                safeWidth
                            ),
                        ]

                        // Extension statuses pack into a single overflow row. Statuses are
                        // opaque text (never parsed); anything that does not fit is
                        // counted as `+N more`, never silently deleted.
                        const statuses = footerData.getExtensionStatuses()
                        const statusLines = Array.from(statuses.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .flatMap(([, text]) => text.split('\n'))
                        const packed = packExtensionStatuses(
                            statusLines,
                            safeWidth,
                            1
                        )
                        if (packed.lines.length > 0) {
                            lines.push(
                                packed.overflow > 0
                                    ? appendOverflowIndicator(
                                          packed.lines[0]!,
                                          packed.overflow,
                                          safeWidth
                                      )
                                    : packed.lines[0]!
                            )
                        } else if (packed.overflow > 0) {
                            lines.push(
                                truncateToWidth(
                                    `+${packed.overflow} more`,
                                    safeWidth
                                )
                            )
                        }

                        return lines
                    },
                }
            }
        )

        ctx.ui.setTitle(`pi · ${title}`)
        pi.events.emit(REFRESH_CHANNEL, undefined)
    }

    pi.on('session_start', (_event, ctx) => {
        title = formatDirectory(ctx.cwd)
        modelInfo = emptyModelInfoState()
        gitInfo = emptyGitInfoState()
        subagentInfo = emptySubagentInfoState()
        discordActivityActive = false
        install(ctx)
    })

    pi.on('session_shutdown', (_event, ctx) => {
        stopModelListener()
        stopGitListener()
        stopDiscordActivityListener()
        stopSubagentListener()
        requestRender = undefined
        if (ctx.mode === 'tui') {
            ctx.ui.setFooter(undefined)
        }
    })
}
