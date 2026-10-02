/**
 * Native projection source for the subagent inspector.
 *
 * Reads committed host state: the session registry document, the native task
 * graph, each conversation's `pi.live` and `pi.usage`, and the newest assistant
 * message for terminal status. The source owns no lifecycle authority; it only
 * projects, watches, and disposes.
 */

import type { Context } from '@earendil-works/chord'
import type {
    ConversationId,
    EntryRecord,
    Harness,
    LiveState,
    TaskGraph,
    UsageState,
} from '@earendil-works/pi-durable'
import { AssistantEntry, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { SubagentsDoc, type SubagentsState } from '../state/subagents-doc.js'
import {
    ownGenerationStatuses,
    type OwnGenerationInfo,
    type OwnGenerationStatus,
} from '../runtime/status.js'
import {
    emptyProjection,
    toProjection,
    type ProjectedAgentInput,
    type SubagentProjection,
    type SubagentProjectionSource,
} from './projection.js'

export interface NativeProjectionSource extends SubagentProjectionSource {
    dispose(): void
}

/** One-shot read of registry, task graph, live state, usage, and terminal status. */
export async function projectOnce(
    harness: Harness,
    context: Context
): Promise<SubagentProjection> {
    const state = await harness.snapshot(SubagentsDoc, context)
    const tasks = await harness.taskGraph(context)
    try {
        return await projectFrom(harness, state, tasks.value, context)
    } finally {
        tasks.dispose()
    }
}

/**
 * Live source for the inspector. Hydrates from the watches' current values
 * before the first projection, serializes refreshes with a dirty bit so rapid
 * commits are not dropped, and reports projection errors instead of serving a
 * stale value silently.
 */
export async function createProjectionSource(
    harness: Harness,
    context: Context,
    onError: (error: unknown) => void
): Promise<NativeProjectionSource> {
    let state: SubagentsState | undefined
    let taskGraph: TaskGraph = { tasks: {} }
    let value: SubagentProjection = emptyProjection()
    let running = false
    let dirty = false
    let disposed = false
    const listeners = new Set<(projection: SubagentProjection) => void>()

    const runRefresh = async (): Promise<void> => {
        if (disposed) return
        if (running) {
            dirty = true
            return
        }
        running = true
        try {
            do {
                dirty = false
                try {
                    const projection = await projectFrom(
                        harness,
                        state,
                        taskGraph,
                        context
                    )
                    if (disposed) return
                    value = projection
                    for (const listener of [...listeners]) listener(projection)
                } catch (error) {
                    onError(error)
                }
            } while (dirty && !disposed)
        } finally {
            running = false
        }
    }
    const refresh = (): void => {
        void runRefresh()
    }

    const tasksWatch = await harness.watchTaskGraph(context)
    taskGraph = tasksWatch.value
    const docWatch = await harness.watchDoc(SubagentsDoc, context)
    if (docWatch === undefined) {
        await tasksWatch.stop()
        throw new Error(
            'Subagents registry document is not initialized; the host must create it before attaching the inspector'
        )
    }
    state = docWatch.value ?? undefined
    try {
        // Hydrate before returning so `read()` never serves an empty projection.
        value = await projectFrom(harness, state, taskGraph, context)
    } catch (error) {
        await tasksWatch.stop()
        await docWatch.stop()
        throw error
    }
    tasksWatch.start(async (graph) => {
        taskGraph = graph
        refresh()
    })
    docWatch.start(async (doc) => {
        state = doc ?? undefined
        refresh()
    })

    return {
        read: () => value,
        subscribe: (listener) => {
            listeners.add(listener)
            refresh()
            return () => {
                listeners.delete(listener)
            }
        },
        activity: (conversationId) =>
            readActivity(harness, conversationId, context),
        watchActivity: (conversationId, listener) => {
            let stopped = false
            let stop: (() => void) | undefined
            void (async () => {
                try {
                    const conversation = await harness.conversation(
                        conversationId,
                        context
                    )
                    if (conversation === undefined || stopped) return
                    const watch = await conversation.watch(context)
                    if (stopped) {
                        void watch.stop()
                        return
                    }
                    listener(formatActivity(watch.value.entries))
                    watch.start(async (view) => {
                        try {
                            listener(formatActivity(view.entries))
                        } catch (error) {
                            onError(error)
                        }
                    })
                    stop = () => {
                        void watch.stop()
                    }
                } catch (error) {
                    onError(error)
                }
            })()
            return () => {
                stopped = true
                stop?.()
            }
        },
        dispose: () => {
            if (disposed) return
            disposed = true
            void tasksWatch.stop()
            void docWatch.stop()
        },
    }
}

async function projectFrom(
    harness: Harness,
    state: SubagentsState | undefined,
    taskGraph: TaskGraph,
    context: Context
): Promise<SubagentProjection> {
    const inputs: ProjectedAgentInput[] = []
    const usageByConversation = new Map<ConversationId, UsageState>()
    const liveByConversation = new Map<ConversationId, LiveState>()
    const metadataList = Object.values(state?.agents ?? {})
    // One task-receipt scan for every conversation; no assistant-history scan.
    const receipts =
        metadataList.length === 0
            ? {
                  statuses: new Map<ConversationId, OwnGenerationInfo>(),
                  answers: new Map<ConversationId, string>(),
              }
            : await harness.commit(async (tx) => {
                  const statuses = await ownGenerationStatuses(
                      tx,
                      metadataList.map((metadata) => metadata.conversationId)
                  )
                  const answers = new Map<ConversationId, string>()
                  for (const [conversationId, info] of statuses) {
                      if (info.answerEntryId === undefined) continue
                      const entry = await tx.entry(
                          AssistantEntry,
                          info.answerEntryId
                      )
                      const text = assistantText(entry?.model?.[0])
                      if (text !== undefined) answers.set(conversationId, text)
                  }
                  return { statuses, answers }
              }, context)
    const terminalByConversation = new Map<
        ConversationId,
        OwnGenerationStatus
    >()
    for (const [conversationId, info] of receipts.statuses) {
        if (info.status !== undefined)
            terminalByConversation.set(conversationId, info.status)
    }
    for (const metadata of metadataList) {
        const conversation = await harness.conversation(
            metadata.conversationId,
            context
        )
        const agent =
            conversation === undefined
                ? undefined
                : await conversation.agent(context)
        const usage = await harness.snapshot(
            UsageDoc,
            metadata.conversationId,
            context
        )
        if (usage !== undefined)
            usageByConversation.set(metadata.conversationId, usage)
        const live = await harness.snapshot(
            LiveDoc,
            metadata.conversationId,
            context
        )
        if (live !== undefined)
            liveByConversation.set(metadata.conversationId, live)
        const lastAnswer = receipts.answers.get(metadata.conversationId)
        inputs.push({
            path: metadata.path,
            name: metadata.name,
            parentPath: metadata.parentPath,
            ...(metadata.role === undefined ? {} : { role: metadata.role }),
            conversationId: metadata.conversationId,
            createdAt: metadata.createdAt,
            ...(agent?.model === undefined
                ? {}
                : { model: `${agent.model.provider}/${agent.model.modelId}` }),
            ...(agent === undefined
                ? {}
                : { thinkingLevel: agent.thinkingLevel }),
            ...(lastAnswer === undefined ? {} : { lastAnswer }),
        })
    }
    return toProjection(
        inputs,
        taskGraph,
        liveByConversation,
        terminalByConversation,
        usageByConversation
    )
}

function assistantText(message: Message | undefined): string | undefined {
    if (
        message?.role !== 'assistant' ||
        (message.stopReason !== 'stop' && message.stopReason !== 'length')
    )
        return undefined
    const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' ')
        .trim()
    return text.length === 0 ? undefined : truncate(text)
}

async function readActivity(
    harness: Harness,
    conversationId: ConversationId,
    context: Context
): Promise<readonly string[]> {
    const conversation = await harness.conversation(conversationId, context)
    if (conversation === undefined) return []
    const page = await conversation.entries({}, 40, undefined, context)
    return formatActivity([...page.items].reverse())
}

function formatActivity(entries: readonly EntryRecord[]): readonly string[] {
    const lines: string[] = []
    for (const entry of entries) {
        const line = formatEntry(entry)
        if (line !== undefined) lines.push(line)
    }
    return lines.slice(-40)
}

function formatEntry(entry: EntryRecord): string | undefined {
    const message = entry.model?.[0]
    if (message === undefined)
        return entry.kind === 'pi.system' ? undefined : entry.kind
    switch (message.role) {
        case 'user': {
            const text = messageText(message.content)
            return text === undefined ? 'user' : `user: ${truncate(text)}`
        }
        case 'assistant': {
            const parts = message.content.map((content) => {
                if (content.type === 'text') return truncate(content.text)
                if (content.type === 'thinking') return '(thinking)'
                return `→ ${content.name}`
            })
            return parts.length === 0
                ? 'assistant'
                : `assistant: ${parts.join(' ')}`
        }
        case 'toolResult': {
            const text = messageText(message.content)
            const detail = text === undefined ? undefined : truncate(text)
            if (message.isError)
                return detail === undefined
                    ? `← ${message.toolName}: error`
                    : `← ${message.toolName}: error: ${detail}`
            return detail === undefined
                ? `← ${message.toolName}`
                : `← ${message.toolName}: ${detail}`
        }
        default:
            return undefined
    }
}

function messageText(
    content:
        string | readonly { readonly type: string; readonly text?: string }[]
): string | undefined {
    if (typeof content === 'string') return content
    const text = content
        .filter(
            (
                block
            ): block is { readonly type: 'text'; readonly text: string } =>
                block.type === 'text' && typeof block.text === 'string'
        )
        .map((block) => block.text)
        .join(' ')
    return text.length === 0 ? undefined : text
}

function truncate(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim()
    // Split by code point so a cut never separates a surrogate pair.
    const points = Array.from(compact)
    return points.length > 120 ? `${points.slice(0, 117).join('')}...` : compact
}
