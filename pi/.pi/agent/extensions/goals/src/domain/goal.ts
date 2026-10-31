/**
 * Domain model for goal tracking.
 *
 * This module is the contract shared by every other module: persisted
 * snapshots, derived metrics, boundary decisions, and the shapes the adapters
 * hand to the engine. It must stay free of Pi and Effect runtime imports; the
 * only dependency is `effect/Schema` for persistence validation.
 */
import { Schema } from "effect";

/** Custom-entry type used for persisted goal snapshots. */
export const GOAL_SNAPSHOT_CUSTOM_TYPE = "goal-snapshot";

/** Custom-message type used for goal directives the model can see. */
export const GOAL_DIRECTIVE_CUSTOM_TYPE = "goal-directive";

/** Custom-entry type written when the user clears the goal (a tombstone). */
export const GOAL_CLEARED_CUSTOM_TYPE = "goal-cleared";

/** Current persisted snapshot version. Bump when the shape changes. */
export const GOAL_SNAPSHOT_VERSION = 1 as const;

/** Maximum objective length, mirroring Codex `MAX_THREAD_GOAL_OBJECTIVE_CHARS`. */
export const MAX_OBJECTIVE_CHARS = 4000;

/** Default hard cap on goal turns when the user sets no budget. */
export const DEFAULT_MAX_GOAL_TURNS = 200;

/** Default consecutive no-activity turns before the circuit breaker stops a goal. */
export const DEFAULT_MAX_IDLE_TURNS = 3;

/** Consecutive goal turns a blocker must persist before `blocked` is allowed. */
export const MIN_BLOCKED_AUDIT_TURNS = 3;

/**
 * Goal lifecycle states. `complete` is terminal; the other terminal-ish states
 * are resumable only by an explicit user action.
 */
export const GOAL_STATUSES = [
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Why a goal is not `active`. */
export const PAUSE_REASONS = [
    "user",
    "interrupted",
    "provider-error",
    "no-progress",
    "turn-cap",
    "forked",
    "internal-error",
] as const;

export type PauseReason = (typeof PAUSE_REASONS)[number];

/** Directive kinds written to the transcript. */
export type DirectiveKind = "kickoff" | "continuation" | "budget-wrapup" | "objective-updated";

/**
 * Details stored on every goal directive custom message. They make turn spans,
 * continuations, and dedupe derivable from the transcript alone.
 */
export interface GoalDirectiveDetails {
    readonly goalId: string;
    readonly kind: DirectiveKind;
    readonly turn: number;
    readonly anchorEntryId: string | null;
}

/** Read directive details defensively from an untyped `details` field. */
export function readDirectiveDetails(details: unknown): GoalDirectiveDetails | null {
    if (typeof details !== "object" || details === null) return null;
    const record = details as Record<string, unknown>;
    if (typeof record.goalId !== "string") return null;
    if (
        record.kind !== "kickoff" &&
        record.kind !== "continuation" &&
        record.kind !== "budget-wrapup" &&
        record.kind !== "objective-updated"
    ) {
        return null;
    }
    if (typeof record.turn !== "number" || !Number.isFinite(record.turn)) return null;
    const anchor = record.anchorEntryId;
    return {
        goalId: record.goalId,
        kind: record.kind,
        turn: record.turn,
        anchorEntryId: typeof anchor === "string" ? anchor : null,
    };
}

/** One persisted status change, used for `/goal history` and diagnostics. */
export const GoalHistoryEntrySchema = Schema.Struct({
    at: Schema.Finite,
    from: Schema.NullOr(Schema.Literals(GOAL_STATUSES)),
    to: Schema.Literals(GOAL_STATUSES),
    reason: Schema.String,
    detail: Schema.optional(Schema.String),
});

export type GoalHistoryEntry = typeof GoalHistoryEntrySchema.Type;

/** Pause metadata. Cleared when the goal becomes active again. */
export const GoalPauseSchema = Schema.Struct({
    reason: Schema.Literals(PAUSE_REASONS),
    detail: Schema.optional(Schema.String),
    at: Schema.Finite,
});

export type GoalPause = typeof GoalPauseSchema.Type;

/** Block metadata. `evidence` is what the model reported, kept for the record. */
export const GoalBlockSchema = Schema.Struct({
    reason: Schema.String,
    evidence: Schema.Array(Schema.String),
    at: Schema.Finite,
});

export type GoalBlock = typeof GoalBlockSchema.Type;

/** Completion bookkeeping used by the audit gate. */
export const GoalCompletionSchema = Schema.Struct({
    attempts: Schema.Finite,
    lastRequestedAt: Schema.NullOr(Schema.Finite),
    verifiedAt: Schema.NullOr(Schema.Finite),
});

export type GoalCompletion = typeof GoalCompletionSchema.Type;

/**
 * Persisted goal state. Everything quantitative (tokens, turns, tool counts,
 * continuations) is derived from the session branch instead of being stored
 * here, so a snapshot can never drift from the transcript.
 */
export const GoalSnapshotV1 = Schema.Struct({
    version: Schema.Literals([GOAL_SNAPSHOT_VERSION]),
    goalId: Schema.String,
    sessionId: Schema.String,
    revision: Schema.Finite,
    status: Schema.Literals(GOAL_STATUSES),
    objective: Schema.String,
    budgetTokens: Schema.NullOr(Schema.Finite),
    /** Branch leaf id at creation; usage before it is not charged to the goal. */
    usageStartEntryId: Schema.NullOr(Schema.String),
    createdAt: Schema.Finite,
    updatedAt: Schema.Finite,
    statusChangedAt: Schema.Finite,
    /** Accumulated wall-clock milliseconds while a goal run was active. */
    activeMs: Schema.Finite,
    /** Goal turn count when the current blocked audit started. */
    turnBaseline: Schema.Finite,
    pause: Schema.NullOr(GoalPauseSchema),
    block: Schema.NullOr(GoalBlockSchema),
    completion: GoalCompletionSchema,
    history: Schema.Array(GoalHistoryEntrySchema),
});

export type GoalSnapshot = typeof GoalSnapshotV1.Type;

/** Versioned union so future shapes can be added without breaking old sessions. */
export const GoalSnapshotSchema = Schema.Union([GoalSnapshotV1]);

/** Minimal usage shape shared with Pi messages. */
export interface UsageSnapshot {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly reasoning?: number;
    readonly totalTokens?: number;
    readonly cost?: { readonly total?: number };
}

/** Message subset the domain reads from a session entry. */
export interface TranscriptMessage {
    readonly role: string;
    readonly usage?: UsageSnapshot;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly content?: unknown;
    readonly timestamp?: number;
}

/**
 * Structural subset of Pi's `SessionEntry` that derivations need. Pi entries are
 * assignable to it, which keeps the domain independent from the Pi package.
 */
export interface TranscriptEntry {
    readonly type: string;
    readonly id: string;
    readonly parentId?: string | null;
    readonly timestamp?: string;
    readonly message?: TranscriptMessage;
    readonly customType?: string;
    /** `usage` entries carry a kind, for example `cache_warm`. */
    readonly kind?: string;
    readonly data?: unknown;
    readonly details?: unknown;
    readonly usage?: UsageSnapshot;
}

/** Token totals charged to a goal. */
export interface GoalUsageTotals {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly reasoning: number;
    /** Provider-billed tokens: input + cacheWrite + output (Codex accounting). */
    readonly tokensUsed: number;
    /** Every recorded token bucket, including cache reads. Informational only. */
    readonly allTokens: number;
    readonly costTotal: number;
}

/** Everything derived from the transcript for one observation point. */
export interface GoalMetrics {
    readonly usage: GoalUsageTotals;
    readonly remainingTokens: number | null;
    /** Goal turns started so far, counting the current one. */
    readonly goalTurns: number;
    /** Goal turns since the current blocked audit started. */
    readonly auditedTurns: number;
    readonly continuationCount: number;
    readonly wrapupCount: number;
    readonly toolCalls: number;
    readonly failedToolCalls: number;
    /** Successful non-goal tool results in the current goal turn. */
    readonly currentTurnEvidence: number;
    /** Current turn produced at least one file mutation. */
    readonly currentTurnMutated: boolean;
    /** Trailing goal turns with no successful non-goal tool result. */
    readonly idleTurns: number;
    readonly activeMs: number;
    /** True when the last branch entry is a goal directive that was never answered. */
    readonly directivePending: boolean;
    readonly lastDirectiveEntryId: string | null;
    /** Assistant entry id the last directive was issued from. */
    readonly lastDirectiveAnchorId: string | null;
}

/** Engine view: persisted snapshot plus derived metrics. */
export interface GoalView {
    readonly snapshot: GoalSnapshot;
    readonly metrics: GoalMetrics;
}

/** Result of loading state for a branch. */
export type GoalLoadIssue =
    | { readonly kind: "corrupt"; readonly entryId: string; readonly message: string }
    | { readonly kind: "unsupported-version"; readonly entryId: string; readonly version: unknown };

export interface GoalLoadResult {
    readonly snapshot: GoalSnapshot | null;
    /** Issues found while scanning, newest first, bounded by the repository. */
    readonly issues: readonly GoalLoadIssue[];
    /** Entry id of the snapshot or tombstone that decided the result. */
    readonly entryId: string | null;
    /** True when the newest goal state is a `cleared` tombstone. */
    readonly cleared: boolean;
}

/** Boundary decision returned by the engine and applied by the Pi adapter. */
export type BoundaryDecision =
    | { readonly kind: "idle"; readonly reason: string; readonly view: GoalView | null }
    | {
          readonly kind: "continue";
          readonly reason: string;
          readonly goalId: string;
          readonly prompt: string;
          readonly directiveKind: Extract<DirectiveKind, "continuation" | "kickoff">;
          readonly view: GoalView;
      }
    | {
          readonly kind: "budget-wrapup";
          readonly reason: string;
          readonly goalId: string;
          readonly prompt: string;
          readonly view: GoalView;
      }
    | {
          readonly kind: "stopped";
          readonly reason: string;
          readonly notice: string;
          readonly view: GoalView | null;
      };

/** Facts the adapter supplies at the settlement boundary. */
export interface BoundaryFacts {
    readonly now: number;
    readonly outcome: "completed" | "aborted" | "error";
    /** Assistant entry that produced this boundary, when it is known. */
    readonly assistantEntryId: string | null;
    /** Provider error text for `outcome: "error"`. */
    readonly errorText: string | null;
}

/**
 * Context every engine call receives.
 *
 * `readBranch` and `appendEntry` run inside the engine's critical section and
 * must address the same session, so a write can never land on a branch other
 * than the one the decision was derived from.
 */
export interface GoalContextInput {
    readonly readBranch: () => readonly TranscriptEntry[];
    readonly appendEntry: (customType: string, data: unknown) => void;
    readonly sessionId: string;
    readonly now: number;
    /**
     * Elapsed time of the run in flight, when a tool call asks for usage. It is
     * added to the reported active time but never persisted; the settlement
     * transition persists the authoritative total.
     */
    readonly elapsedMs?: number;
}

/** User-issued commands from `/goal`. */
export type UserCommand =
    | { readonly type: "create"; readonly objective: string; readonly budgetTokens: number | null }
    | { readonly type: "pause"; readonly detail?: string }
    | { readonly type: "resume" }
    | { readonly type: "clear" }
    | { readonly type: "edit"; readonly objective: string }
    | { readonly type: "setBudget"; readonly budgetTokens: number | null };

/** Model-issued tool calls. */
export type GoalToolCall =
    | { readonly type: "get" }
    | { readonly type: "create"; readonly objective: string; readonly budgetTokens: number | null }
    | {
          readonly type: "update";
          readonly status: "complete" | "blocked" | "paused";
          readonly reason?: string;
          readonly evidence?: readonly string[];
          /** Set by the adapter after the user explicitly authorized a pause. */
          readonly pauseAuthorized?: boolean;
      };

/** Outcome of a user command or tool call. */
export interface GoalActionResult {
    readonly ok: boolean;
    readonly message: string;
    readonly view: GoalView | null;
    /** Snapshot after the action, or null when the goal was cleared. */
    readonly snapshot: GoalSnapshot | null;
    /** Set when a command starts or resumes work immediately. */
    readonly kickoffPrompt?: string;
    readonly directiveKind?: DirectiveKind;
    /** Structured payload for tool results. */
    readonly structured?: GoalToolPayload;
}

/** Codex-compatible tool result payload. */
export interface GoalToolPayload {
    readonly goal: {
        readonly threadId: string;
        readonly goalId: string;
        readonly objective: string;
        readonly status: GoalStatus;
        readonly tokenBudget?: number;
        readonly tokensUsed: number;
        readonly timeUsedSeconds: number;
        readonly createdAt: number;
        readonly updatedAt: number;
    } | null;
    readonly remainingTokens: number | null;
    readonly completionBudgetReport: string | null;
}

/** Reason codes for typed domain failures. */
export const GOAL_ERROR_CODES = [
    "no-goal",
    "unfinished-goal",
    "invalid-transition",
    "invalid-objective",
    "invalid-budget",
    "completion-rejected",
    "blocked-rejected",
    "pause-unauthorized",
    "goal-cleared",
    "stale-goal",
    "persistence-failed",
    "usage-limit-active",
    "budget-exceeded",
] as const;

export type GoalErrorCode = (typeof GOAL_ERROR_CODES)[number];

/** Remaining token budget, or null when unbounded. */
export function remainingTokens(
    budgetTokens: number | null,
    tokensUsed: number,
): number | null {
    if (budgetTokens === null) return null;
    return Math.max(0, budgetTokens - tokensUsed);
}

/** Whether the budget is exhausted. */
export function isBudgetExhausted(
    budgetTokens: number | null,
    tokensUsed: number,
): boolean {
    return budgetTokens !== null && tokensUsed >= budgetTokens;
}
