import { AgentCapacityReachedError } from './errors.ts'

export interface ExecutionPermit {
    readonly sequence: number
    release(): void
}

/** Limits active child runs without limiting the number of logical agents. */
export class ExecutionLimiter {
    private activeCount = 0
    private nextSequence = 0
    private readonly limit: number

    constructor(limit: number) {
        this.limit = limit
    }

    get active(): number {
        return this.activeCount
    }

    get capacity(): number {
        return this.limit
    }

    tryAcquire(): ExecutionPermit {
        if (this.activeCount >= this.limit) {
            throw new AgentCapacityReachedError(this.limit, this.activeCount)
        }
        this.activeCount += 1
        const sequence = ++this.nextSequence
        let released = false
        return {
            sequence,
            release: () => {
                if (released) return
                released = true
                this.activeCount = Math.max(0, this.activeCount - 1)
            },
        }
    }
}
