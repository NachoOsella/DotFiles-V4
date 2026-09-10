/** Deterministic fake host for parity tests (no model calls). */

import type { AgentPath } from './ids.ts'
import type { ForkTurns } from './communication.ts'
import {
    emptySessionUsage,
    selectForkHistory,
    type HostSessionHandle,
    type HostTurnResult,
    type PiHost,
    type SessionUsage,
} from './host.ts'

interface FakeSession extends HostSessionHandle {
    messages: string[]
    results: HostTurnResult[]
    failures: string[]
    gates: Array<{ wait: Promise<void>; release: () => void }>
    interrupted: boolean
    activeTurns: number
    closed: boolean
    usage: SessionUsage
}

function makeGate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
        release = resolve
    })
    return { wait, release }
}

export class FakePiHost implements PiHost {
    readonly sessions = new Map<string, FakeSession>()
    readonly created: HostSessionHandle[] = []
    readonly createdOptions: Array<{
        model?: string
        reasoningEffort?: string
        fork: ForkTurns
    }> = []
    closedCount = 0
    private counter = 0
    private paused = false
    private resumeResolvers: Array<() => void> = []

    /** Pause all future turns (deterministic Running assertions). */
    pause(): void {
        this.paused = true
    }

    /** Resume paused turns. */
    resume(): void {
        this.paused = false
        const resolvers = this.resumeResolvers.splice(0)
        for (const resolve of resolvers) resolve()
    }

    private async waitIfPaused(signal: AbortSignal): Promise<void> {
        if (!this.paused) return
        await Promise.race([
            new Promise<void>((resolve) => {
                this.resumeResolvers.push(resolve)
            }),
            new Promise<void>((_, reject) => {
                if (signal.aborted) {
                    reject(new Error('Aborted'))
                    return
                }
                signal.addEventListener(
                    'abort',
                    () => reject(new Error('Aborted')),
                    {
                        once: true,
                    }
                )
            }),
        ])
    }

    private opts: { cwd?: string; model?: { provider: string; id: string } }

    constructor(
        opts: { cwd?: string; model?: { provider: string; id: string } } = {}
    ) {
        this.opts = opts
    }

    async getCwd(): Promise<string> {
        return this.opts.cwd ?? '/repo'
    }

    async getModel() {
        return this.opts.model ?? { provider: 'test', id: 'test-model' }
    }

    async createSession(options: {
        agentPath: AgentPath
        fork: ForkTurns
        parentHistory: readonly string[]
        model?: string
        reasoningEffort?: string
        role?: string
    }): Promise<HostSessionHandle> {
        this.counter += 1
        const forkMessages = selectForkHistory(
            options.parentHistory,
            options.fork
        )
        const session: FakeSession = {
            handleId: `fake-${this.counter}`,
            persistedId: `persisted-${this.counter}`,
            forkMessages,
            messages: [...forkMessages],
            results: [],
            failures: [],
            gates: [],
            interrupted: false,
            activeTurns: 0,
            closed: false,
            usage: emptySessionUsage('test', 'test-model'),
        }
        this.sessions.set(session.handleId, session)
        this.created.push(session)
        this.createdOptions.push({
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            fork: options.fork,
        })
        return session
    }

    /** Queue the result for a future runTurn on the given session. */
    queueResult(handleId: string, lastMessage: string | null): void {
        this.require(handleId).results.push({ lastMessage })
    }

    /** Make a future runTurn throw with the given error. */
    queueFailure(handleId: string, error: string): void {
        this.require(handleId).failures.push(error)
    }

    /** Set the cumulative usage reported by getUsage for a session. */
    setUsage(handleId: string, usage: Partial<SessionUsage>): void {
        const session = this.require(handleId)
        session.usage = { ...session.usage, ...usage }
    }

    async getUsage(session: HostSessionHandle): Promise<SessionUsage> {
        const fake = this.sessions.get(session.handleId)
        if (!fake) return emptySessionUsage('test', 'test-model')
        return {
            ...fake.usage,
            toolCalls: fake.usage.toolCalls.map((entry) => ({ ...entry })),
        }
    }

    /**
     * Gate the next runTurn: it waits until release() is called.
     * The waiter resolves promptly on abort.
     */
    gateNextTurn(handleId: string): { release: () => void } {
        const session = this.require(handleId)
        const gate = makeGate()
        session.gates.push(gate)
        return { release: gate.release }
    }

    async runTurn(
        session: HostSessionHandle,
        input: string,
        signal: AbortSignal
    ): Promise<HostTurnResult> {
        const fake = this.require(session.handleId)
        if (fake.closed) throw new Error('session closed')
        fake.messages.push(input)
        fake.activeTurns += 1
        try {
            await this.waitIfPaused(signal)
            const gate = fake.gates.shift()
            if (gate) {
                await Promise.race([
                    gate.wait,
                    new Promise<void>((_, reject) => {
                        if (signal.aborted) {
                            reject(new Error('Aborted'))
                            return
                        }
                        signal.addEventListener(
                            'abort',
                            () => reject(new Error('Aborted')),
                            {
                                once: true,
                            }
                        )
                    }),
                ])
            }
            if (signal.aborted) throw new Error('Aborted')
            if (fake.interrupted) throw new Error('Aborted')
            const failure = fake.failures.shift()
            if (failure !== undefined) throw new Error(failure)
            return fake.results.shift() ?? { lastMessage: 'ok' }
        } finally {
            fake.activeTurns -= 1
            // An interrupt belongs to the turn it targeted; never let the
            // flag leak into the next turn on the same session.
            fake.interrupted = false
        }
    }

    async interruptTurn(session: HostSessionHandle): Promise<void> {
        const fake = this.require(session.handleId)
        // No-op while idle so a late interrupt never poisons the next turn.
        if (fake.activeTurns > 0) fake.interrupted = true
    }

    async closeSession(session: HostSessionHandle): Promise<void> {
        const fake = this.sessions.get(session.handleId)
        if (fake && !fake.closed) {
            fake.closed = true
            this.closedCount += 1
        }
    }

    async appendMessage(
        session: HostSessionHandle,
        text: string
    ): Promise<void> {
        this.require(session.handleId).messages.push(text)
    }

    historyOf(handleId: string): readonly string[] {
        return [...this.require(handleId).messages]
    }

    private require(handleId: string): FakeSession {
        const session = this.sessions.get(handleId)
        if (!session) throw new Error(`unknown fake session ${handleId}`)
        return session
    }
}
