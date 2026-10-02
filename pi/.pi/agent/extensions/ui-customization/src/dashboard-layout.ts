import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { fmtCost } from '../../session-stats/format.ts'
import type { PromptTokens } from '../../shared/dashboard-state.ts'

// Pure dashboard layout helpers (P11).
// Every function here is synchronous, deterministic, and performs no
// filesystem/process work, so footer rendering stays cheap and safe
// to call on every repaint. Inputs are treated as opaque text: helpers
// measure visible width (ANSI-aware) but never parse semantic state out of
// colored strings.

export function normalizeWidth(width: unknown, fallback = 80): number {
    if (typeof width !== 'number' || !Number.isFinite(width)) return fallback
    return Math.max(1, Math.floor(width))
}

// Existing two-column footer layout with a bounded 45/55 fallback split.
// Pure: no filesystem/process access; safe for widths down to 1.
export function columns(left: string, right: string, width: number): string {
    const safeWidth = normalizeWidth(width)
    if (!right) return truncateToWidth(left, safeWidth)

    const naturalGap = safeWidth - visibleWidth(left) - visibleWidth(right)
    if (naturalGap >= 1) return `${left}${' '.repeat(naturalGap)}${right}`

    const leftWidth = Math.max(1, Math.floor(safeWidth * 0.45))
    const rightWidth = Math.max(1, safeWidth - leftWidth - 1)
    const fittedLeft = truncateToWidth(left, leftWidth)
    const fittedRight = truncateToWidth(right, rightWidth)
    const gap = Math.max(
        1,
        safeWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight)
    )
    return truncateToWidth(
        `${fittedLeft}${' '.repeat(gap)}${fittedRight}`,
        safeWidth
    )
}

export function formatModelLabel(
    provider: string,
    modelId: string,
    thinking: string
): string {
    // Legacy shape: without a provider the footer shows the bare model id.
    if (!provider) return modelId
    const base = `${provider}/${modelId}`
    return thinking ? `${base} · ${thinking}` : base
}

export function formatModelLabelWithoutProvider(
    modelId: string,
    thinking: string
): string {
    return thinking ? `${modelId} · ${thinking}` : modelId
}

export function formatSubagentCount(running: number): string {
    if (!Number.isFinite(running)) return ''
    const count = Math.max(0, Math.floor(running))
    if (count === 0) return ''
    return `● ${count} ${count === 1 ? 'subagent' : 'subagents'}`
}

// Live streaming estimates carry a `~` prefix; measured final cadences do
// not. Null/unknown throughput renders as an em-dash placeholder.
export function formatThroughput(
    tokensPerSecond: number | null,
    isEstimate: boolean
): string {
    if (
        tokensPerSecond === null ||
        typeof tokensPerSecond !== 'number' ||
        !Number.isFinite(tokensPerSecond)
    ) {
        return '— tok/s'
    }
    const rounded = Math.round(tokensPerSecond)
    return isEstimate ? `~${rounded} tok/s` : `${rounded} tok/s`
}

export function formatTokens(tokens: number): string {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '?'
    if (tokens < 1_000) return `${Math.floor(tokens)}`
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`
    return `${(tokens / 1_000_000).toFixed(1)}m`
}

export interface UsageLabelInput {
    contextPercent: number | null
    contextWindow: number
    cost: number
    throughput: string
    subagentsRunning?: number
    /** Session prompt-token buckets, parent plus logical children. */
    promptTokens?: PromptTokens
    includeThroughput?: boolean
}

export function formatUsageLabel(input: UsageLabelInput): string {
    const percent =
        input.contextPercent === null ||
        typeof input.contextPercent !== 'number' ||
        !Number.isFinite(input.contextPercent)
            ? '?'
            : `${Math.round(input.contextPercent)}`
    const window =
        typeof input.contextWindow === 'number' &&
        Number.isFinite(input.contextWindow) &&
        input.contextWindow > 0
            ? formatTokens(input.contextWindow)
            : '?'
    const cost =
        typeof input.cost === 'number' && Number.isFinite(input.cost)
            ? input.cost
            : 0
    const subagentCount = formatSubagentCount(input.subagentsRunning ?? 0)
    const subagentSuffix = subagentCount ? ` · ${subagentCount}` : ''
    const money = cost === 0 ? '$0.00' : fmtCost(Math.max(0, cost))
    const cacheLabel = formatCacheShare(input.promptTokens)
    const cacheSegment = cacheLabel ? ` · ${cacheLabel}` : ''
    const base = `${percent}%/${window} · ${money}${cacheSegment}`
    return input.includeThroughput === false
        ? `${base}${subagentSuffix}`
        : `${base} · ${input.throughput}${subagentSuffix}`
}

export function formatCacheShare(tokens: PromptTokens | undefined): string {
    if (!tokens) return ''
    const { input, cacheRead, cacheWrite } = tokens
    const promptTokens = input + cacheRead + cacheWrite
    if (promptTokens <= 0 || cacheRead + cacheWrite <= 0) return ''
    return `CH${((cacheRead / promptTokens) * 100).toFixed(1)}%`
}

export interface GitLabelInput {
    branch: string | null
    changedFiles: number
    pullRequestNumber: number | null
    includePullRequest?: boolean
    stale?: boolean
}

export function formatGitLabel(input: GitLabelInput): string {
    if (!input.branch) return ''
    const files =
        typeof input.changedFiles === 'number' &&
        Number.isFinite(input.changedFiles)
            ? Math.max(0, Math.floor(input.changedFiles))
            : 0
    const fileLabel = files === 1 ? 'file' : 'files'
    let label = `${input.branch} · ${files} ${fileLabel} changed`
    if (
        input.includePullRequest !== false &&
        input.pullRequestNumber !== null
    ) {
        label += ` · PR #${input.pullRequestNumber}`
    }
    if (input.stale === true) label += ' (stale)'
    return label
}

export interface FooterFitInput {
    width: number
    directory: string
    provider: string
    modelId: string
    thinking: string
    contextPercent: number | null
    contextWindow: number
    cost: number
    tokensPerSecond: number | null
    throughputIsEstimate: boolean
    subagentsRunning?: number
    promptTokens?: PromptTokens
    branch: string | null
    changedFiles: number
    pullRequestNumber: number | null
    gitStale?: boolean
}

export interface FooterFitOutput {
    row1Left: string
    row1Right: string
    row2Left: string
    row2Right: string
    // Degradation steps applied, in order. Optional segments are dropped before
    // critical state is ever truncated: PR label, throughput, provider prefix,
    // then long path segments.
    dropped: string[]
}

function rowsFit(
    row1Left: string,
    row1Right: string,
    row2Left: string,
    row2Right: string,
    width: number
): boolean {
    return (
        visibleWidth(row1Left) +
            (row1Right ? visibleWidth(row1Right) + 1 : 0) <=
            width &&
        visibleWidth(row2Left) +
            (row2Right ? visibleWidth(row2Right) + 1 : 0) <=
            width
    )
}

function basenameSegment(path: string): string {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return path
    const last = parts[parts.length - 1]!
    return path.startsWith('~') ? `…/${last}` : `…/${last}`
}

// Priority degradation for the two primary footer rows. Returns exactly two
// rows worth of segments (unthemed); the caller themes them and lays them
// out with columns(), which truncates only as a last resort.
export function fitFooterSegments(input: FooterFitInput): FooterFitOutput {
    const width = normalizeWidth(input.width)
    const dropped: string[] = []
    let includePr = true
    let includeThroughput = true
    let includeProvider = true
    let directory = input.directory

    const build = () => {
        const throughput = formatThroughput(
            input.tokensPerSecond,
            input.throughputIsEstimate
        )
        const model = includeProvider
            ? formatModelLabel(input.provider, input.modelId, input.thinking)
            : formatModelLabelWithoutProvider(input.modelId, input.thinking)
        const usage = formatUsageLabel({
            contextPercent: input.contextPercent,
            contextWindow: input.contextWindow,
            cost: input.cost,
            throughput,
            subagentsRunning: input.subagentsRunning,
            promptTokens: input.promptTokens,
            includeThroughput,
        })
        const git = formatGitLabel({
            branch: input.branch,
            changedFiles: input.changedFiles,
            pullRequestNumber: input.pullRequestNumber,
            includePullRequest: includePr,
            stale: input.gitStale,
        })
        return { model, usage, git }
    }

    let current = build()
    if (rowsFit(directory, current.model, current.usage, current.git, width)) {
        return {
            row1Left: directory,
            row1Right: current.model,
            row2Left: current.usage,
            row2Right: current.git,
            dropped,
        }
    }

    // 1. Drop the PR label (recoverable via /pr and the git extension).
    includePr = false
    dropped.push('pr')
    current = build()
    if (rowsFit(directory, current.model, current.usage, current.git, width)) {
        return {
            row1Left: directory,
            row1Right: current.model,
            row2Left: current.usage,
            row2Right: current.git,
            dropped,
        }
    }

    // 2. Drop live throughput (context % and cost are more critical).
    includeThroughput = false
    dropped.push('throughput')
    current = build()
    if (rowsFit(directory, current.model, current.usage, current.git, width)) {
        return {
            row1Left: directory,
            row1Right: current.model,
            row2Left: current.usage,
            row2Right: current.git,
            dropped,
        }
    }

    // 3. Drop the provider prefix (model id + thinking remain).
    includeProvider = false
    dropped.push('provider-prefix')
    current = build()
    if (rowsFit(directory, current.model, current.usage, current.git, width)) {
        return {
            row1Left: directory,
            row1Right: current.model,
            row2Left: current.usage,
            row2Right: current.git,
            dropped,
        }
    }

    // 4. Shorten long paths to their final segment before truncating state.
    if (directory.length > 1) {
        directory = basenameSegment(directory)
        dropped.push('path')
        current = build()
    }

    return {
        row1Left: directory,
        row1Right: current.model,
        row2Left: current.usage,
        row2Right: current.git,
        dropped,
    }
}

export interface PackedStatuses {
    // Packed single-line rows, each already truncated to width.
    lines: string[]
    // Statuses that did not fit; the caller must surface this count (e.g.
    // "+N more") rather than silently deleting them.
    overflow: number
}

// Pack short extension statuses into at most maxLines rows. Statuses are
// opaque text: they are measured (ANSI-aware) and joined, never parsed for
// semantic state. Every input is either shown or counted in overflow.
export function packExtensionStatuses(
    statusLines: string[],
    width: number,
    maxLines = 1
): PackedStatuses {
    const safeWidth = normalizeWidth(width)
    const safeMax = Math.max(1, Math.floor(maxLines) || 1)
    const lines = statusLines.filter((line) => line.length > 0)
    if (lines.length === 0) return { lines: [], overflow: 0 }

    const packed: string[] = []
    let current = ''
    let consumed = 0
    let stopped = false
    for (const line of lines) {
        const candidate = current ? `${current} · ${line}` : line
        if (current !== '' && visibleWidth(candidate) > safeWidth) {
            packed.push(truncateToWidth(current, safeWidth))
            if (packed.length >= safeMax) {
                stopped = true
                break
            }
            current = line
            consumed += 1
            continue
        }
        current = candidate
        consumed += 1
    }
    if (!stopped && current) {
        packed.push(truncateToWidth(current, safeWidth))
    }
    return { lines: packed, overflow: Math.max(0, lines.length - consumed) }
}

// Append an overflow indicator without silently deleting statuses. Returns
// the packed line plus a short overflow row when needed.
export function appendOverflowIndicator(
    packedLine: string,
    overflow: number,
    width: number
): string {
    const safeWidth = normalizeWidth(width)
    if (overflow <= 0) return truncateToWidth(packedLine, safeWidth)
    const indicator = `+${overflow} more`
    if (!packedLine) return truncateToWidth(indicator, safeWidth)
    const candidate = `${packedLine} · ${indicator}`
    if (visibleWidth(candidate) <= safeWidth) return candidate
    // Indicator wins over tail content: critical count info is preserved.
    const room = Math.max(0, safeWidth - visibleWidth(indicator) - 3)
    return `${truncateToWidth(packedLine, room)} · ${indicator}`
}
