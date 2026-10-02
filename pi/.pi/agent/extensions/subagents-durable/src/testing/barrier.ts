/**
 * Deterministic storage barrier for crash and restart tests.
 *
 * The gate lets the wrapped commit become durable, then blocks the caller until
 * `release()` is called or the commit's context is aborted. Tests can therefore
 * stop a task exactly after a chosen durable checkpoint without sleeping or
 * adding production hooks.
 */

import type { Context } from '@earendil-works/chord'
import type { Seq, Storage, StorageWrite } from '@earendil-works/pi-durable'

/** Whether a commit's writes are the checkpoint the test wants to stop after. */
export type StoragePredicate = (writes: readonly StorageWrite[]) => boolean

export type GatedStorage = {
    /** Drop-in storage whose `commit` blocks after the first matching write. */
    readonly storage: Storage
    /** Resolves once the matching commit is durable, before the caller resumes. */
    readonly hit: Promise<void>
    /** Let the blocked commit continue; idempotent. */
    release(): void
}

/** Reject when `signal` aborts; never settles when it is absent. */
export function abortRejection(
    signal: AbortSignal | undefined
): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return
        const rejectWith = () =>
            reject(signal.reason ?? new Error('operation aborted'))
        if (signal.aborted) {
            rejectWith()
            return
        }
        signal.addEventListener('abort', rejectWith, { once: true })
    })
}

/**
 * Wrap `base` so the first commit matching `predicate` is durable before the
 * caller is held. The held commit rejects when its context aborts, which is how
 * an in-process graceful close simulates a process that died right after the
 * durable write.
 */
export function createGatedStorage(
    base: Storage,
    predicate: StoragePredicate
): GatedStorage {
    let signaled = false
    let released = false
    let hitResolve!: () => void
    const hit = new Promise<void>((resolve) => {
        hitResolve = resolve
    })
    let releaseResolve!: () => void
    const releasedPromise = new Promise<void>((resolve) => {
        releaseResolve = resolve
    })

    const storage = new Proxy(base, {
        get(target, property, receiver) {
            if (property === 'commit') {
                return async (
                    writes: readonly StorageWrite[],
                    context: Context
                ): Promise<Seq> => {
                    const seq = await target.commit(writes, context)
                    if (!signaled && predicate(writes)) {
                        signaled = true
                        hitResolve()
                        await Promise.race([
                            releasedPromise,
                            abortRejection(context.abortSignal),
                        ])
                    }
                    return seq
                }
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value
        },
    }) as Storage

    return {
        storage,
        hit,
        release: () => {
            if (released) return
            released = true
            releaseResolve()
        },
    }
}
