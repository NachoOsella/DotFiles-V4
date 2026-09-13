export type ActivityKind =
    'thinking' | 'message' | 'tool' | 'tool_result' | 'final'

export interface ActivityEntry {
    readonly id: number
    readonly at: number
    readonly kind: ActivityKind
    readonly summary: string
    readonly live?: boolean
}

const MAX_SUMMARY_CHARS = 12_000

/** Session-long UI activity that never enters an agent's model context. */
export class ActivityFeed {
    private readonly entries = new Map<string, ActivityEntry[]>()
    private readonly liveEntries = new Map<
        string,
        Map<ActivityKind, ActivityEntry>
    >()
    private nextId = 0

    push(path: string, kind: ActivityKind, summary: string): void {
        const clean = cleanSummary(summary)
        if (!clean) return
        const next = this.entries.get(path) ?? []
        if (kind === 'final') {
            const last = next.at(-1)
            // The terminal payload usually repeats the last streamed message.
            // Upgrade that entry instead of showing the same text twice.
            if (last?.kind === 'final' && last.summary === clean) return
            if (last?.kind === 'message' && last.summary === clean) {
                next.pop()
            }
        }
        next.push({ id: ++this.nextId, at: Date.now(), kind, summary: clean })
        this.entries.set(path, next)
    }

    updateLive(
        path: string,
        kind: 'thinking' | 'message',
        summary: string
    ): void {
        const clean = cleanSummary(summary)
        const byKind = this.liveEntries.get(path) ?? new Map()
        if (!clean) byKind.delete(kind)
        else {
            const existing = byKind.get(kind)
            byKind.set(kind, {
                id: existing?.id ?? ++this.nextId,
                at: Date.now(),
                kind,
                summary: clean,
                live: true,
            })
        }
        this.liveEntries.set(path, byKind)
    }

    commitLive(path: string): void {
        const live = this.liveEntries.get(path)
        if (!live) return
        const entries = this.entries.get(path) ?? []
        entries.push(
            ...[...live.values()]
                .sort((left, right) => left.id - right.id)
                .map((entry) => ({ ...entry, live: false }))
        )
        this.entries.set(path, entries)
        this.liveEntries.delete(path)
    }

    get(path: string): readonly ActivityEntry[] {
        return [
            ...(this.entries.get(path) ?? []),
            ...[...(this.liveEntries.get(path)?.values() ?? [])].sort(
                (left, right) => left.id - right.id
            ),
        ]
    }

    clear(): void {
        this.entries.clear()
        this.liveEntries.clear()
    }
}

function cleanSummary(summary: string): string {
    return [...summary.trim()].slice(0, MAX_SUMMARY_CHARS).join('')
}
