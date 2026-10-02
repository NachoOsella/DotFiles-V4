/**
 * Test harness factory.
 *
 * Uses the real Durable `Harness` over real storage with a scripted pi-ai faux
 * provider. No mocks and no production testing hooks: tests drive the same
 * public APIs a host would.
 *
 * By default a tasks-only extension installs `AnchorTask` and `ReporterTask`,
 * because the native collaboration extension is owned elsewhere. A caller that
 * installs the native extension supplies its own `registry` (or `extensions`)
 * and leaves the default tasks out.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { createModels, fauxProvider } from '@earendil-works/pi-ai'
import type { FauxProviderHandle, MutableModels } from '@earendil-works/pi-ai'
import {
    Harness,
    createRegistry,
    defineExtension,
} from '@earendil-works/pi-durable'
import type {
    AnyTask,
    Extension,
    HarnessOptions,
    HarnessSettings,
    Registry,
    Storage,
} from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import type { PassiveWriter } from '../extension.js'
import { AnchorTask } from '../tasks/anchor-task.js'
import { ReporterTask } from '../tasks/reporter-task.js'

export type TestHarnessOptions = {
    /** Storage backend; defaults to a fresh `MemoryStorage`. */
    readonly storage?: Storage
    /** Cancellation and values for every harness call; defaults to `BACKGROUND_CONTEXT`. */
    readonly context?: Context
    /** Prebuilt registry. When set, default test tasks are not installed. */
    readonly registry?: Registry
    /** Extra extensions installed into the registry. */
    readonly extensions?: readonly Extension[]
    /** Task definitions to install; defaults to `[AnchorTask, ReporterTask]`. */
    readonly tasks?: readonly AnyTask[]
    readonly settings?: HarnessSettings
    /** Model collection; defaults to a fresh `createModels()`. */
    readonly models?: MutableModels
    /** Scripted provider handle; defaults to a fresh `fauxProvider()`. */
    readonly faux?: FauxProviderHandle
    readonly now?: () => number
    readonly env?: HarnessOptions['env']
    readonly onReport?: (error: unknown) => void
    /** Skip `resume()`; defaults to resuming so tasks start. */
    readonly resume?: boolean
}

export type TestHarness = {
    readonly harness: Harness
    readonly storage: Storage
    readonly models: MutableModels
    readonly faux: FauxProviderHandle | undefined
    readonly registry: Registry
    readonly context: Context
    /** Provider id of the default model for `configure()` calls. */
    readonly provider: string
    /** Model id of the default model for `configure()` calls. */
    readonly modelId: string
    /** Host passive writer bound to this harness, for `send_message` tests. */
    readonly submitWrite: PassiveWriter
}

export async function createTestHarness(
    options: TestHarnessOptions = {}
): Promise<TestHarness> {
    const storage = options.storage ?? new MemoryStorage()
    const models = options.models ?? createModels()
    const faux =
        options.faux ??
        (options.models === undefined ? fauxProvider() : undefined)
    if (faux !== undefined) models.setProvider(faux.provider)

    const registry = options.registry ?? createRegistry()
    if (options.tasks !== undefined) {
        if (options.tasks.length > 0) {
            registry.install(
                defineExtension({
                    name: 'subagents-test-tasks',
                    tasks: options.tasks,
                })
            )
        }
    } else if (
        options.registry === undefined &&
        (options.extensions === undefined || options.extensions.length === 0)
    ) {
        registry.install(
            defineExtension({
                name: 'subagents-test-tasks',
                tasks: [AnchorTask, ReporterTask],
            })
        )
    }
    for (const extension of options.extensions ?? []) {
        registry.install(extension)
    }

    const context = options.context ?? BACKGROUND_CONTEXT
    const defaultModel = faux?.getModel() ?? models.getModels()[0]
    if (defaultModel === undefined) {
        throw new Error('createTestHarness requires at least one model')
    }

    const harness = await Harness.open(
        storage,
        {
            models,
            registry,
            ...(options.settings === undefined
                ? {}
                : { settings: options.settings }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.onReport === undefined
                ? {}
                : { onReport: options.onReport }),
        },
        context
    )
    if (options.resume !== false) harness.resume()

    const submitWrite: PassiveWriter = async (
        conversationId,
        draft,
        context
    ) => {
        const conversation = await harness.conversation(conversationId, context)
        if (conversation === undefined) {
            throw new Error(`Conversation ${conversationId} is missing`)
        }
        return conversation.submit(draft, context)
    }

    return {
        harness,
        storage,
        models,
        faux,
        registry,
        context,
        provider: defaultModel.provider,
        modelId: defaultModel.id,
        submitWrite,
    }
}
