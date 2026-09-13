export interface ActivityEntry {
    readonly at: number
    readonly kind: 'thinking' | 'tool' | 'message'
    readonly summary: string
}

const MAX_ENTRIES = 6
const MAX_SUMMARY_CHARS = 240

/** Bounded UI activity; entries never enter an agent's model context. */
export class ActivityFeed {
    private readonly entries = new Map<string, ActivityEntry[]>()

    push(path: string, kind: ActivityEntry['kind'], summary: string): void {
        const clean = [...summary]
            .slice(0, MAX_SUMMARY_CHARS)
            .join('')
            .replace(/[\r\n]+/g, ' ')
        const next = [
            ...(this.entries.get(path) ?? []),
            {
                at: Date.now(),
                kind,
                summary: clean,
            },
        ]
        this.entries.set(path, next.slice(-MAX_ENTRIES))
    }

    get(path: string): readonly ActivityEntry[] {
        return this.entries.get(path) ?? []
    }

    clear(): void {
        this.entries.clear()
    }
}
