/**
 * Native Durable host helper.
 *
 * Opens one Harness over per-host storage, installs the native subagents
 * extension plus optional coding tools and tool search, wraps the host's model
 * collection with the request limiter, creates the session registry document
 * and root conversation, and resumes task scheduling. It supplies the passive
 * writer the extension needs by delegating to the public
 * `Conversation.submit({ type: "write" })`.
 *
 * There is no AgentSession adapter, no transcript import, no MCP extension, and
 * no shared storage filename. A host that opens a second Harness against the
 * same file concurrently violates Durable's single-process storage ownership.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { withoutAbortSignal } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import type {
    Harness,
    HarnessOptions,
    HarnessSettings,
    Registry,
    Storage,
} from '@earendil-works/pi-durable'
import {
    Harness as DurableHarness,
    createRegistry,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { loadConfig } from './config/load.js'
import type { SubagentsConfig } from './config/config.js'
import type { PassiveWriter } from './extension.js'
import { createSubagentsExtension } from './extension.js'
import {
    createCodingToolsExtension,
    createNodeEnvironment,
    type NodeEnvironmentOptions,
} from './integrations/coding-tools.js'
import { createToolSearchExtension } from './integrations/tool-search.js'
import { ExecutionLimiter, limitModels } from './runtime/execution-limiter.js'
import { SubagentsDoc } from './state/subagents-doc.js'
import type { SubagentProjection } from './ui/projection.js'
import {
    createProjectionSource,
    projectOnce,
    type NativeProjectionSource,
} from './ui/source.js'

export interface OpenSubagentsHarnessOptions {
    /** The host's model collection; wrapped, never mutated. */
    readonly models: Models
    /** Pre-opened storage. Mutually exclusive with `storagePath`; omit both for the default SQLite path. */
    readonly storage?: Storage
    /** SQLite file. `~` expands to the home directory. */
    readonly storagePath?: string
    /** Stable per-host identifier for the default SQLite filename. Required unless `storage` or `storagePath` is set. */
    readonly hostId?: string
    readonly config?: SubagentsConfig
    /** Registry to extend. Default: a fresh registry holding the Durable built-in tasks. */
    readonly registry?: Registry
    readonly settings?: HarnessSettings
    /** Execution environment. Default: a local Node environment when coding tools are installed. */
    readonly env?: HarnessOptions['env']
    readonly nodeEnvironment?: NodeEnvironmentOptions
    /** Install `CodingTools` (read/write/edit/bash). Default true. */
    readonly codingTools?: boolean
    /** Install the native `tool_search` extension. Default true. */
    readonly toolSearch?: boolean
    readonly now?: () => number
    readonly onReport?: (error: unknown) => void
}

export interface SubagentsHarnessHandle {
    readonly harness: Harness
    /** The limiter-wrapped collection to pass to model consumers. */
    readonly models: Models
    readonly limiter: ExecutionLimiter
    readonly registry: Registry
    readonly storage: Storage
    /** Resolved SQLite path when this handle opened file-backed storage. */
    readonly storagePath?: string
    readonly submitWrite: PassiveWriter
    /** One-shot read-only projection of registry, task graph, and usage. */
    project(context: Context): Promise<SubagentProjection>
    /** Live read-only projection source for the inspector. Dispose it when finished. */
    watchProjection(context: Context): Promise<NativeProjectionSource>
    close(context: Context): Promise<void>
}

/** `~/.pi/agent/subagents-durable/<hostId>.sqlite`, isolated per host. */
export function defaultSubagentsStoragePath(hostId: string): string {
    assertSafeHostId(hostId)
    return join(
        homedir(),
        '.pi',
        'agent',
        'subagents-durable',
        `${hostId}.sqlite`
    )
}

const SAFE_HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Reject empty, dotted, and traversal host ids instead of rewriting them. */
function assertSafeHostId(hostId: string): void {
    if (!SAFE_HOST_ID.test(hostId)) {
        throw new TypeError(
            `hostId must be a safe filename segment, got ${JSON.stringify(hostId)}`
        )
    }
}

export async function openSubagentsHarness(
    options: OpenSubagentsHarnessOptions,
    context: Context
): Promise<SubagentsHarnessHandle> {
    if (options.storage !== undefined && options.storagePath !== undefined) {
        throw new TypeError(
            'openSubagentsHarness accepts either storage or storagePath, not both'
        )
    }
    if (
        options.storage === undefined &&
        options.storagePath === undefined &&
        options.hostId === undefined
    ) {
        throw new TypeError(
            'openSubagentsHarness requires hostId, storagePath, or storage so a restart can reopen the same state'
        )
    }
    const config = options.config ?? loadConfig()
    const limiter = new ExecutionLimiter(config.maxConcurrentExecutions)
    const models = limitModels(options.models, limiter)
    const registry = options.registry ?? createRegistry()
    const codingTools = options.codingTools ?? true
    const toolSearch = options.toolSearch ?? true
    const env =
        options.env ??
        (codingTools
            ? createNodeEnvironment(options.nodeEnvironment)
            : undefined)
    const report = options.onReport ?? (() => {})

    let harness: Harness | undefined
    const submitWrite: PassiveWriter = async (
        conversationId,
        draft,
        callContext
    ) => {
        const open = harness
        if (open === undefined) throw new Error('Subagents harness is not open')
        const conversation = await open.conversation(
            conversationId,
            callContext
        )
        if (conversation === undefined)
            throw new Error(`Conversation ${conversationId} does not exist`)
        return conversation.submit(draft, callContext)
    }

    registry.install(createSubagentsExtension({ config, submitWrite }))
    if (codingTools) registry.install(createCodingToolsExtension())
    if (toolSearch) registry.install(createToolSearchExtension())

    const storagePath =
        options.storage !== undefined
            ? undefined
            : expandHome(
                  options.storagePath ??
                      defaultSubagentsStoragePath(options.hostId!)
              )
    const storage =
        options.storage ?? (await openNodeSqliteStorage(storagePath!))
    try {
        const opened = await DurableHarness.open(
            storage,
            {
                models,
                registry,
                ...(options.settings === undefined
                    ? {}
                    : { settings: options.settings }),
                ...(env === undefined ? {} : { env }),
                ...(options.now === undefined ? {} : { now: options.now }),
                onReport: report,
            },
            context
        )
        harness = opened
        // The session registry document must exist before any watcher attaches, or
        // a first spawn would never be observed. Root, then explicit resume: pending
        // tasks of installed extensions resume only after every definition exists.
        await opened.commit((tx) => tx.doc(SubagentsDoc), context)
        await opened.root(context)
        opened.resume()
        const host = opened
        return {
            harness: host,
            models,
            limiter,
            registry,
            storage,
            ...(storagePath === undefined ? {} : { storagePath }),
            submitWrite,
            project: (projectContext) => projectOnce(host, projectContext),
            watchProjection: (watchContext) =>
                createProjectionSource(host, watchContext, report),
            close: (closeContext) => host.close(closeContext),
        }
    } catch (error) {
        // Cleanup must not be cancelled by the caller's context, and must close the
        // Harness (not raw storage) when the scheduler is live.
        const cleanup = withoutAbortSignal(context)
        try {
            if (harness !== undefined) await harness.close(cleanup)
            else await storage.close(cleanup)
        } catch {
            // Preserve the original open failure.
        }
        throw error
    }
}

function expandHome(path: string): string {
    if (path === '~') return homedir()
    if (path.startsWith('~/')) return join(homedir(), path.slice(2))
    return path
}
