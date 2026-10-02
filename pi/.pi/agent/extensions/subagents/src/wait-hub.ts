export type WaitNotificationKind = 'mailbox' | 'steer'

interface WaitState {
    sequence: number
    observed: number
    kind: WaitNotificationKind | null
    listeners: Set<() => void>
}

export interface WaitOutcome {
    readonly kind: WaitNotificationKind
    readonly timedOut: boolean
}

/** A wait ended because its caller aborted or the coordinator shut down. */
export class WaitCancelledError extends Error {
    constructor() {
        super('Wait cancelled.')
        this.name = 'WaitCancelledError'
    }
}

/** Synchronization only. Message content remains in the owning session. */
export class WaitHub {
    private readonly states = new Map<string, WaitState>()
    /** Cancels in-flight waits; used by abort signals and shutdown. */
    private readonly pending = new Set<() => void>()
    /** Paths blocked in `wait`, so the inspector can tell waiting from working. */
    private readonly waiting = new Map<string, number>()

    /** Whether an agent is currently blocked in `wait`. */
    isWaiting(path: string): boolean {
        return (this.waiting.get(path) ?? 0) > 0
    }

    private state(path: string): WaitState {
        let state = this.states.get(path)
        if (!state) {
            state = {
                sequence: 0,
                observed: 0,
                kind: null,
                listeners: new Set(),
            }
            this.states.set(path, state)
        }
        return state
    }

    notify(path: string, kind: WaitNotificationKind): void {
        const state = this.state(path)
        if (kind === 'steer') {
            // Steering is an edge-triggered wakeup. Do not carry input from a
            // completed turn into the next wait_agent invocation.
            if (state.listeners.size === 0) return
            state.kind = kind
        } else {
            // Mailbox notifications remain level-triggered so messages that
            // arrive before wait_agent are observed by its first check.
            state.sequence += 1
            state.kind = kind
        }
        for (const listener of [...state.listeners]) listener()
    }

    notifyMailbox(path: string): void {
        this.notify(path, 'mailbox')
    }

    notifySteer(path: string): void {
        this.notify(path, 'steer')
    }

    hasPending(path: string): boolean {
        const state = this.state(path)
        return state.sequence > state.observed
    }

    async wait(
        path: string,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<WaitOutcome> {
        if (signal?.aborted) throw new WaitCancelledError()
        const state = this.state(path)
        if (state.sequence > state.observed) {
            state.observed = state.sequence
            return {
                kind: state.kind ?? 'mailbox',
                timedOut: false,
            }
        }

        return await this.trackWaiting(
            path,
            () =>
                new Promise<WaitOutcome>((resolve, reject) => {
                    let settled = false
                    const cleanup = () => {
                        clearTimeout(timer)
                        state.listeners.delete(onNotify)
                        signal?.removeEventListener('abort', onAbort)
                        this.pending.delete(onAbort)
                    }
                    const finish = (outcome: WaitOutcome) => {
                        if (settled) return
                        settled = true
                        cleanup()
                        if (!outcome.timedOut) state.observed = state.sequence
                        resolve(outcome)
                    }
                    const onNotify = () => {
                        finish({
                            kind: state.kind ?? 'mailbox',
                            timedOut: false,
                        })
                    }
                    const onAbort = () => {
                        if (settled) return
                        settled = true
                        cleanup()
                        reject(new WaitCancelledError())
                    }
                    const timer = setTimeout(
                        () => finish({ kind: 'mailbox', timedOut: true }),
                        timeoutMs
                    )
                    state.listeners.add(onNotify)
                    signal?.addEventListener('abort', onAbort, { once: true })
                    this.pending.add(onAbort)

                    // Subscribe and check again to close the lost-wakeup window.
                    if (state.sequence > state.observed) onNotify()
                })
        )
    }

    private async trackWaiting<T>(
        path: string,
        run: () => Promise<T>
    ): Promise<T> {
        this.waiting.set(path, (this.waiting.get(path) ?? 0) + 1)
        try {
            return await run()
        } finally {
            const remaining = (this.waiting.get(path) ?? 1) - 1
            if (remaining > 0) this.waiting.set(path, remaining)
            else this.waiting.delete(path)
        }
    }

    /** Cancel every in-flight wait, for example while the session shuts down. */
    clear(): void {
        for (const cancel of [...this.pending]) cancel()
        for (const state of this.states.values()) state.listeners.clear()
        this.states.clear()
        this.waiting.clear()
    }
}
