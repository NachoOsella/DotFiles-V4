/**
 * Domain model for subagents.
 *
 * Everything downstream of the Pi backend (manager, tools, UI) speaks only
 * these types. The backend translates Pi session events into the normalized
 * `SubagentEvent` union.
 */

import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import { Data } from 'effect'

export const BACKEND_NAMES = ['pi'] as const
export type BackendName = (typeof BACKEND_NAMES)[number]

/** Pi thinking levels. Omitted values inherit the parent level. */
export const REASONING_EFFORTS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export type SubagentStatus = 'running' | 'done' | 'error' | 'closed'

export type SubagentRunStatus =
    'running' | 'completed' | 'failed' | 'interrupted'

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
    readonly parentCwd: string
    /** Persisted parent session path used to associate child usage with /stats. */
    readonly parentSession?: string
    readonly projectTrusted: boolean
    /** Parent pi model, for the pi backend's "inherit" default. */
    readonly inheritedModel?: { readonly provider: string; readonly id: string }
    readonly inheritedThinkingLevel?: string
    /** Parent model registry; required by the pi backend to resolve models. */
    readonly modelRegistry?: ModelRegistry
}

export interface SpawnTask {
    readonly prompt: string
    readonly title: string
    /** Stable task label. The manager derives one from title when omitted. */
    readonly taskName?: string
    /** Selected child role. The manager uses "default" when omitted. */
    readonly role?: string
    /** Assigned by the manager before the backend creates the child session. */
    readonly agentId?: string
    /** Assigned by the manager for the first run. */
    readonly runId?: string
    /** Child-only questions enter the parent manager mailbox through this hook. */
    readonly reportToParent?: (message: string) => void
    readonly cwd: string
    /** Pi model hint: "provider/model-id" or a bare model id. */
    readonly model?: string
    /** Pi thinking level. */
    readonly reasoningEffort?: ReasoningEffort
    /** Optional absolute or cwd-relative paths this task intends to modify. */
    readonly ownedPaths?: ReadonlyArray<string>
    readonly parent: ParentContext
}

export interface SubagentRun {
    readonly id: string
    readonly agentId: string
    readonly status: SubagentRunStatus
    readonly startedAt: number
    readonly finishedAt?: number
    readonly output?: string
    readonly error?: string
}

export interface SubagentMeta {
    readonly backend: BackendName
    /** Display label, e.g. "provider/model-id". */
    readonly modelLabel?: string
    /** Effective thinking level used by the child session. */
    readonly thinkingLevel?: string
    /** Context window capacity for utilization display, when known. */
    readonly contextWindow?: number
    /** Pi session file path. */
    readonly sessionFilePath?: string
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
    | { readonly type: 'text'; readonly text: string }
    | {
          readonly type: 'thinking'
          readonly text: string
          readonly redacted?: boolean
      }
    | {
          readonly type: 'toolCall'
          readonly toolId: string
          readonly name: string
          readonly argsPreview?: string
      }

export type TranscriptItem =
    | { readonly kind: 'user'; readonly text: string }
    | {
          readonly kind: 'assistant'
          readonly parts: ReadonlyArray<TranscriptPart>
      }
    | {
          readonly kind: 'toolResult'
          readonly toolId: string
          readonly name: string
          readonly isError: boolean
          readonly outputPreview?: string
      }

export interface LiveToolState {
    readonly toolId: string
    readonly name: string
    readonly argsPreview?: string
    readonly outputPreview?: string
    readonly done?: boolean
    readonly isError?: boolean
}

export interface QueuedMessage {
    readonly text: string
    readonly kind: 'steer' | 'follow-up'
    readonly runId?: string
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
    | { readonly _tag: 'Completed'; readonly finalText: string }
    | {
          readonly _tag: 'Failed'
          readonly errorText: string
          readonly partialText?: string
      }
    | { readonly _tag: 'Interrupted'; readonly partialText?: string }

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
    // lifecycle (a session can run multiple turns via send())
    | { readonly _tag: 'RunStarted'; readonly runId: string }
    | {
          readonly _tag: 'RunSettled'
          readonly runId: string
          readonly outcome: RunOutcome
      }
    // transcript building blocks
    | {
          readonly _tag: 'UserMessage'
          readonly text: string
          readonly runId?: string
      }
    | {
          readonly _tag: 'AssistantDelta'
          readonly kind: 'text' | 'thinking'
          readonly delta: string
          readonly runId?: string
      }
    | {
          readonly _tag: 'AssistantMessage'
          readonly parts: ReadonlyArray<TranscriptPart>
          readonly runId?: string
      }
    | {
          readonly _tag: 'ToolStart'
          readonly toolId: string
          readonly name: string
          readonly argsPreview?: string
          readonly runId?: string
      }
    | {
          readonly _tag: 'ToolUpdate'
          readonly toolId: string
          readonly outputPreview?: string
          readonly runId?: string
      }
    | {
          readonly _tag: 'ToolEnd'
          readonly toolId: string
          readonly name: string
          readonly isError: boolean
          readonly outputPreview?: string
          readonly runId?: string
      }
    // bookkeeping
    | {
          readonly _tag: 'QueueChanged'
          readonly queued: ReadonlyArray<QueuedMessage>
          readonly runId?: string
      }
    | {
          readonly _tag: 'UsageChanged'
          readonly tokens?: number
          readonly contextWindow?: number
          readonly runId?: string
      }
    | {
          readonly _tag: 'MetaChanged'
          readonly meta: Partial<SubagentMeta>
          readonly runId?: string
      }
    /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
    | {
          readonly _tag: 'BackendError'
          readonly message: string
          readonly runId?: string
      }

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
    readonly id: string
    readonly backend: BackendName
    readonly title: string
    readonly taskName?: string
    readonly role?: string
    /** Increments for every visible snapshot change. */
    readonly version?: number
    /** Explicit cache identity for transcript and live activity rendering. */
    readonly transcriptVersion?: number
    /** Sequence of the most recent terminal mailbox envelope, when published. */
    readonly lastMailboxSequence?: number
    readonly prompt: string
    readonly cwd: string
    readonly status: SubagentStatus
    readonly currentRunId?: string
    readonly lastRun?: SubagentRun
    readonly ownedPaths: ReadonlyArray<string>
    readonly ownershipWarning?: string
    readonly createdAt: number
    readonly settledAt?: number
    readonly errorText?: string
    readonly meta: SubagentMeta
    readonly usage: {
        readonly tokens?: number
        readonly contextWindow?: number
    }
    readonly transcript: ReadonlyArray<TranscriptItem>
    /** Streaming assistant buffers, cleared when the finalized message lands. */
    readonly liveAssistant?: {
        readonly text: string
        readonly thinking: string
    }
    readonly liveTools: ReadonlyArray<LiveToolState>
    readonly queued: ReadonlyArray<QueuedMessage>
    /** Final text of the most recent completed run (v1 `finalOutput`). */
    readonly finalText: string
    /** Count of finalized assistant messages (for subagent_check). */
    readonly turns: number
}

/** Format the model and effective thinking level for compact status displays. */
export function formatModelWithThinking(
    meta: Pick<SubagentMeta, 'modelLabel' | 'thinkingLevel'>,
    fallback = '?'
): string {
    const model = meta.modelLabel ?? fallback
    return meta.thinkingLevel ? `${model} (${meta.thinkingLevel})` : model
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
    const live = snap.liveAssistant?.text.trim()
    if (live) return live
    return snap.finalText
}

export function formatElapsed(snap: SubagentSnapshot) {
    const end = snap.settledAt ?? Date.now()
    const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return minutes > 0
        ? `${minutes}m${seconds.toString().padStart(2, '0')}s`
        : `${seconds}s`
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError('SpawnError')<{
    readonly message: string
}> {}

export class BackendUnavailableError extends Data.TaggedError(
    'BackendUnavailableError'
)<{
    readonly message: string
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
    'ConcurrencyLimitError'
)<{
    readonly message: string
}> {}

export class SendError extends Data.TaggedError('SendError')<{
    readonly message: string
}> {}
