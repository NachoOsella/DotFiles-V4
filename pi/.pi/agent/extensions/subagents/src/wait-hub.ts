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

/** Synchronization only. Message content remains in the owning session. */
export class WaitHub {
    private readonly states = new Map<string, WaitState>()

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
        state.sequence += 1
        state.kind = kind
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

    async wait(path: string, timeoutMs: number): Promise<WaitOutcome> {
        const state = this.state(path)
        if (state.sequence > state.observed) {
            state.observed = state.sequence
            return {
                kind: state.kind ?? 'mailbox',
                timedOut: false,
            }
        }

        return await new Promise<WaitOutcome>((resolve) => {
            let settled = false
            const finish = (outcome: WaitOutcome) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                state.listeners.delete(onNotify)
                if (!outcome.timedOut) state.observed = state.sequence
                resolve(outcome)
            }
            const onNotify = () => {
                finish({
                    kind: state.kind ?? 'mailbox',
                    timedOut: false,
                })
            }
            const timer = setTimeout(
                () => finish({ kind: 'mailbox', timedOut: true }),
                timeoutMs
            )
            state.listeners.add(onNotify)

            // Subscribe and check again to close the lost-wakeup window.
            if (state.sequence > state.observed) onNotify()
        })
    }

    clear(): void {
        for (const state of this.states.values()) state.listeners.clear()
        this.states.clear()
    }
}
