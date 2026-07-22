import { Cause, Effect, Exit, ManagedRuntime } from 'effect'
import type { LspConfig } from '../types.ts'
import { makeLspLayer, LspService, type LspServiceShape } from './service.ts'
import type { LspError } from './errors.ts'
import type { LspService as LspServiceType } from './service.ts'

export function createRuntime(config: LspConfig, cwd: string) {
    return ManagedRuntime.make(makeLspLayer(config, cwd))
}

export type LspRuntime = ReturnType<typeof createRuntime>

export async function runLsp<A, E = LspError, R = never>(
    runtime: LspRuntime,
    effect: Effect.Effect<A, E, LspServiceType>,
    options: { signal?: AbortSignal; interruptMessage?: string } = {}
): Promise<A> {
    const exit = await runtime.runPromiseExit(
        effect,
        options.signal ? { signal: options.signal } : undefined
    )
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasInterruptsOnly(exit.cause)) {
        throw new Error(
            options.interruptMessage ?? 'LSP operation was aborted.'
        )
    }
    const [first] = Cause.prettyErrors(exit.cause)
    throw new Error(first?.message ?? Cause.pretty(exit.cause))
}

export function serviceEffect<A>(
    effect: (service: LspServiceShape) => Effect.Effect<A, LspError>
) {
    return Effect.gen(function* () {
        return yield* effect(yield* LspService)
    })
}
