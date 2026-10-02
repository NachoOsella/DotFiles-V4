/**
 * Host-side model request gate.
 *
 * Durable 1.0.0 has no global model concurrency setting, so the host bounds
 * concurrent provider operations. One permit covers one provider request and is
 * released when it terminates or the caller cancels; a run frees capacity while
 * its tools execute or it waits.
 */

import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    DeferredHandle,
    Model,
    Models,
    ModelsApiStreamOptions,
    ModelsDeferredFetchOptions,
    ModelsSimpleStreamOptions,
    Usage,
} from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

const ZERO_USAGE: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

type Waiter = {
    resolve(release: () => void): void
    reject(error: unknown): void
    signal: AbortSignal | undefined
    onAbort: (() => void) | undefined
}

/** Counting semaphore for provider requests. */
export class ExecutionLimiter {
    readonly #limit: number
    #active = 0
    readonly #waiters: Waiter[] = []

    constructor(limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new RangeError(
                `Execution limiter must be a positive integer, got ${limit}`
            )
        }
        this.#limit = limit
    }

    get limit(): number {
        return this.#limit
    }

    get active(): number {
        return this.#active
    }

    /**
     * Wait for a permit. The returned release is idempotent. An aborted signal
     * rejects, including one already aborted. A signal aborted between grant and
     * the caller resuming is handled by `run` and `limitedStream`, which check
     * again before using the permit.
     */
    acquire(signal: AbortSignal | undefined): Promise<() => void> {
        signal?.throwIfAborted()
        if (this.#active < this.#limit) {
            this.#active += 1
            return Promise.resolve(this.#release())
        }
        return new Promise<() => void>((resolve, reject) => {
            const waiter: Waiter = {
                resolve,
                reject,
                signal,
                onAbort: undefined,
            }
            if (signal !== undefined) {
                waiter.onAbort = () => {
                    const index = this.#waiters.indexOf(waiter)
                    if (index < 0) return
                    this.#waiters.splice(index, 1)
                    reject(signal.reason ?? new Error('Model request aborted'))
                }
                signal.addEventListener('abort', waiter.onAbort, { once: true })
                if (signal.aborted) {
                    waiter.onAbort()
                    return
                }
            }
            this.#waiters.push(waiter)
        })
    }

    /** Run one operation under a permit; a cancellation releases it early. */
    async run<T>(
        signal: AbortSignal | undefined,
        operation: () => Promise<T>
    ): Promise<T> {
        const release = await this.acquire(signal)
        let released = false
        const drop = (): void => {
            if (released) return
            released = true
            signal?.removeEventListener('abort', drop)
            release()
        }
        try {
            // The permit may have been granted just before the caller aborted.
            if (signal?.aborted === true)
                throw signal.reason ?? new Error('Model request aborted')
            signal?.addEventListener('abort', drop, { once: true })
            return await operation()
        } finally {
            drop()
        }
    }

    #release(): () => void {
        let released = false
        return () => {
            if (released) return
            released = true
            this.#active -= 1
            this.#drain()
        }
    }

    #drain(): void {
        while (this.#active < this.#limit) {
            const waiter = this.#waiters.shift()
            if (waiter === undefined) return
            if (waiter.onAbort !== undefined)
                waiter.signal?.removeEventListener('abort', waiter.onAbort)
            if (waiter.signal?.aborted === true) {
                waiter.reject(
                    waiter.signal.reason ?? new Error('Model request aborted')
                )
                continue
            }
            this.#active += 1
            waiter.resolve(this.#release())
        }
    }
}

/**
 * Wrap a `Models` collection so provider requests pass through `limiter`. Every
 * forwarded method is bound to the target, so `this` and private state stay
 * intact; `complete`/`completeSimple` resolve through the target's own stream
 * methods, so one call takes exactly one permit.
 */
export function limitModels(models: Models, limiter: ExecutionLimiter): Models {
    return new Proxy(models, {
        get(target, property) {
            switch (property) {
                case 'stream':
                    return (
                        model: Model<Api>,
                        context: never,
                        options?: ModelsApiStreamOptions<Api>
                    ) =>
                        limitedStream(model, limiter, options?.signal, () =>
                            target.stream(model, context, options)
                        )
                case 'streamSimple':
                    return (
                        model: Model<Api>,
                        context: never,
                        options?: ModelsSimpleStreamOptions
                    ) =>
                        limitedStream(model, limiter, options?.signal, () =>
                            target.streamSimple(model, context, options)
                        )
                case 'streamDeferred':
                    return (
                        model: Model<Api>,
                        handle: DeferredHandle,
                        options?: ModelsDeferredFetchOptions
                    ) =>
                        limitedStream(model, limiter, options?.signal, () =>
                            target.streamDeferred(model, handle, options)
                        )
                case 'complete':
                    return (
                        model: Model<Api>,
                        context: never,
                        options?: ModelsApiStreamOptions<Api>
                    ) =>
                        limiter.run(options?.signal, () =>
                            target.complete(model, context, options)
                        )
                case 'completeSimple':
                    return (
                        model: Model<Api>,
                        context: never,
                        options?: ModelsSimpleStreamOptions
                    ) =>
                        limiter.run(options?.signal, () =>
                            target.completeSimple(model, context, options)
                        )
                case 'fetchDeferred':
                    return (
                        model: Model<Api>,
                        handle: DeferredHandle,
                        options?: ModelsDeferredFetchOptions
                    ) =>
                        limiter.run(options?.signal, () =>
                            target.fetchDeferred(model, handle, options)
                        )
                default: {
                    const value: unknown = Reflect.get(target, property, target)
                    return typeof value === 'function'
                        ? (value as (...args: never[]) => unknown).bind(target)
                        : value
                }
            }
        },
    })
}

/**
 * Forward a provider stream while holding one permit. The permit is released
 * before a terminal event is handed downstream, so a consumer that starts the
 * next request from that event never waits on its own permit.
 */
function limitedStream(
    model: Model<Api> | undefined,
    limiter: ExecutionLimiter,
    signal: AbortSignal | undefined,
    open: () => AssistantMessageEventStream
): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream()
    void (async () => {
        let release: (() => void) | undefined
        try {
            release = await limiter.acquire(signal)
        } catch (error) {
            fail(out, model, error, true)
            return
        }
        let released = false
        const drop = (): void => {
            if (released) return
            released = true
            signal?.removeEventListener('abort', drop)
            release?.()
        }
        try {
            // The permit may have been granted just before the caller aborted.
            if (signal?.aborted === true) {
                drop()
                fail(out, model, signal.reason, true)
                return
            }
            signal?.addEventListener('abort', drop, { once: true })
            const source = open()
            for await (const event of source) {
                if (event.type === 'done' || event.type === 'error') drop()
                out.push(event)
            }
            const result = await source.result()
            drop()
            out.end(result)
        } catch (error) {
            drop()
            fail(out, model, error, signal?.aborted === true)
        }
    })()
    return out
}

/** Terminal error event for a request that never produced a provider message. */
function fail(
    out: AssistantMessageEventStream,
    model: Model<Api> | undefined,
    error: unknown,
    aborted: boolean
): void {
    const message = failureMessage(model, error, aborted)
    out.push({
        type: 'error',
        reason: aborted ? 'aborted' : 'error',
        error: message,
    })
    out.end(message)
}

function failureMessage(
    model: Model<Api> | undefined,
    error: unknown,
    aborted: boolean
): AssistantMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        api: model?.api ?? 'unknown',
        provider: model?.provider ?? 'unknown',
        model: model?.id ?? 'unknown',
        usage: ZERO_USAGE,
        stopReason: aborted ? 'aborted' : 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    }
}
