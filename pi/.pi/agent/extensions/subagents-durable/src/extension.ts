/**
 * Native Durable extension factory.
 *
 * A native host installs the returned extension in its Registry before opening
 * storage and calling `resume()`. The extension owns no Harness, models,
 * storage, or global state: everything lives in Durable conversations, tasks,
 * and documents.
 *
 * The one host exception is `submitWrite`. Durable 1.0.0 task-acquired
 * conversation handles accept input submissions only, so `send_message` cannot
 * reach `pi.inbox` from a tool. The host supplies its public
 * `Conversation.submit({ type: "write", ... })` through this function. The
 * extension never implements admission or queues itself.
 */

import type { Context } from '@earendil-works/chord'
import {
    defineExtension,
    ROOT_CONVERSATION_ID,
    section,
} from '@earendil-works/pi-durable'
import type {
    ConversationId,
    Extension,
    Submission,
    SubmissionDraft,
    ToolRegistration,
} from '@earendil-works/pi-durable'
import { DEFAULT_CONFIG, type SubagentsConfig } from './config/config.js'
import { assembleRootPrompt, resolveConfiguredMode } from './config/prompts.js'
import { AnchorTask } from './tasks/anchor-task.js'
import { ReporterTask } from './tasks/reporter-task.js'
import { buildTools, type RuntimeDeps } from './tools/index.js'

/** Installed name of this extension. */
export const SUBAGENTS_DURABLE_EXTENSION = 'subagents-durable'

/**
 * Admit one passive model-contributing write. The host passes its public
 * `Conversation.submit` narrowed to write submissions. It must not queue or
 * deduplicate on its own: Durable admission owns both.
 */
export type PassiveWriter = (
    conversationId: ConversationId,
    draft: Extract<SubmissionDraft, { type: 'write' }>,
    context: Context
) => Promise<Submission>

export interface SubagentsExtensionOptions {
    /** Decoded subagents configuration. Defaults to {@link DEFAULT_CONFIG}. */
    readonly config?: SubagentsConfig
    /** Host-supplied passive write path. */
    readonly submitWrite: PassiveWriter
}

/**
 * Build the native subagents extension. When `config.enabled` is false the
 * extension registers no tools; task definitions stay installed so pending
 * durable work can still resume.
 */
export function createSubagentsExtension(
    options: SubagentsExtensionOptions
): Extension<ToolRegistration> {
    const config = options.config ?? DEFAULT_CONFIG
    const deps: RuntimeDeps = {
        config,
        submitWrite: options.submitWrite,
    }
    return defineExtension({
        name: SUBAGENTS_DURABLE_EXTENSION,
        tools: config.enabled ? buildTools(deps) : [],
        sections: config.enabled
            ? [
                  section('subagents', ({ conversationId, agent }) =>
                      conversationId === ROOT_CONVERSATION_ID
                          ? assembleRootPrompt({
                                config,
                                mode: resolveConfiguredMode(
                                    config,
                                    agent.thinkingLevel
                                ),
                                activeSlotCount: config.maxConcurrentExecutions,
                            })
                          : undefined
                  ),
              ]
            : [],
        tasks: [AnchorTask, ReporterTask],
    })
}
