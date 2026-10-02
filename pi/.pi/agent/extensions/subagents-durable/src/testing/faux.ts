/**
 * Scripted faux response that a test can hold and release deterministically.
 *
 * The factory resolves only after `release()` or the request's abort signal, so
 * a test can observe a child run mid-flight without sleeping.
 */

import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { FauxResponseFactory } from '@earendil-works/pi-ai'
import { abortRejection } from './barrier.js'

export type FauxGate = {
    /** Resolves when the held response is requested. */
    readonly started: Promise<void>
    release(): void
    readonly response: FauxResponseFactory
}

export function createFauxGate(answer = 'held answer'): FauxGate {
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => {
        startedResolve = resolve
    })
    let releaseResolve!: () => void
    const released = new Promise<void>((resolve) => {
        releaseResolve = resolve
    })
    const response: FauxResponseFactory = async (_context, options) => {
        startedResolve()
        await Promise.race([released, abortRejection(options?.signal)])
        return fauxAssistantMessage(answer)
    }
    return { started, release: releaseResolve, response }
}
