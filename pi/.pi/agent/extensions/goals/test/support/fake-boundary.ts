/**
 * Driver for Pi's settlement boundary loop, modelled on Pi 1.4.0.
 *
 * `driveGoalTurns` replays one boundary dispatch per settled assistant turn:
 * decide, commit drafts, continue the model, repeat. The caller prepares the
 * session (user prompt and the first assistant response) and the driver starts
 * at the boundary; it never appends a user message on its own.
 *
 * Modelled Pi semantics:
 * - drafts are committed in order before the continuation decision (Pi commits
 *   `result.entries` either way; only `continue` changes control flow);
 * - one boundary yields at most one continuation;
 * - `continue: true` with no draft requires runnable model context: the last
 *   projected role must not be `assistant` and at least one non-system message
 *   must exist, otherwise Pi reports "requested continuation without runnable
 *   model context" and settles.
 *
 * Not modelled: queued/steering messages (`hasQueuedMessages`), the shared
 * cumulative `continue` flag across handlers, and `_abortDuringBeforeSettle`.
 */
import { newestAssistantEntry, type FakeEntry, type FakeSession } from "./fake-session.ts";

/** Boundary cap used when the caller passes none. */
export const DEFAULT_DRIVER_MAX_TURNS = 50;

export interface BoundaryRequest {
    readonly session: FakeSession;
    readonly outcome: "completed" | "aborted" | "error";
    readonly assistantEntryId: string | null;
    readonly errorText: string | null;
    readonly now: number;
}

export interface BoundaryDraft {
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
    readonly details?: unknown;
}

export interface BoundaryPlan {
    readonly continue: boolean;
    readonly entries?: readonly BoundaryDraft[];
}

export interface DriveTurnsResult {
    /**
     * Boundaries evaluated. Equals the number of settled assistant turns the
     * driver observed, including the final turn whose plan stopped the loop.
     */
    readonly turns: number;
    /** Times a `continue: true` decision was applied and the model was asked again. */
    readonly continuations: number;
    readonly stoppedBy: "decision" | "max-turns";
}

export interface DriveGoalTurnsOptions {
    readonly decide: (request: BoundaryRequest) => BoundaryPlan;
    /** The test's model: append the assistant/tool entries produced by this turn. */
    readonly respond: (turn: number, session: FakeSession) => void;
    /** Maximum boundaries to evaluate; guards against an always-continue plan. */
    readonly maxTurns?: number;
}

// This harness never appends system entries, so Pi's "non-system context"
// requirement reduces to "at least one projected message".
type ProjectedRole = "user" | "assistant" | "toolResult";

/**
 * Role an entry contributes to the projected LLM context. Plain `custom` and
 * `usage` entries contribute nothing; `custom_message` and `compaction` project
 * to `user`.
 */
function projectedRole(entry: FakeEntry): ProjectedRole | null {
    if (entry.type === "custom_message" || entry.type === "compaction") return "user";
    if (entry.type !== "message") return null;
    const role = entry.message?.role;
    if (role === "user" || role === "assistant" || role === "toolResult") return role;
    return null;
}

/** Pi's `canContinue` check for a boundary that returned `continue` without drafts. */
function requireRunnableContext(session: FakeSession): void {
    const roles: ProjectedRole[] = [];
    for (const entry of session.buildContextEntries()) {
        const role = projectedRole(entry);
        if (role !== null) roles.push(role);
    }
    const lastRole = roles.length === 0 ? null : (roles[roles.length - 1] ?? null);
    if (lastRole !== null && lastRole !== "assistant") return;
    const detail =
        lastRole === "assistant"
            ? "the last projected message is an assistant message and no draft was appended"
            : "the projected context has no non-system message";
    throw new Error(
        `agent_before_settle requested continuation without runnable model context: ${detail}`,
    );
}

function buildBoundaryRequest(session: FakeSession): BoundaryRequest {
    return {
        session,
        outcome: "completed",
        assistantEntryId: newestAssistantEntry(session.getBranch())?.id ?? null,
        errorText: null,
        now: session.now(),
    };
}

/**
 * Run the settlement loop.
 *
 * Each iteration computes `assistantEntryId` from the newest assistant message
 * on the branch, asks `decide`, commits the returned drafts as custom messages,
 * and on `continue: true` calls `respond` before evaluating the next boundary.
 * `maxTurns` caps evaluated boundaries; the loop reports `"max-turns"` instead
 * of evaluating one more.
 */
export function driveGoalTurns(session: FakeSession, options: DriveGoalTurnsOptions): DriveTurnsResult {
    const maxTurns = Math.max(0, Math.floor(options.maxTurns ?? DEFAULT_DRIVER_MAX_TURNS));
    let turns = 0;
    let continuations = 0;

    for (;;) {
        if (turns >= maxTurns) return { turns, continuations, stoppedBy: "max-turns" };
        turns += 1;

        const plan = options.decide(buildBoundaryRequest(session));
        const drafts = plan.entries ?? [];
        for (const draft of drafts) {
            session.appendCustomMessage(draft.customType, draft.content, draft.display, draft.details);
        }

        if (!plan.continue) return { turns, continuations, stoppedBy: "decision" };
        if (drafts.length === 0) requireRunnableContext(session);

        continuations += 1;
        options.respond(turns, session);
    }
}

export interface AbortedTurnResult {
    readonly assistantEntryId: string;
    readonly outcome: "aborted";
    /** Pi skips the boundary when the run was aborted. */
    readonly boundaryInvoked: false;
}

/**
 * Model an interrupted run: append the partial assistant turn (Pi persists it
 * with `stopReason: "aborted"`), then signal the abort through `respond` (for
 * example to record `agent_settled{aborted: true}`). No boundary is dispatched.
 */
export function driveAbortedTurn(
    session: FakeSession,
    respond: (session: FakeSession) => void = () => {},
): AbortedTurnResult {
    const entry = session.appendAssistant({ stopReason: "aborted" });
    respond(session);
    return { assistantEntryId: entry.id, outcome: "aborted", boundaryInvoked: false };
}

/**
 * Model a failed provider attempt: append an assistant message with
 * `stopReason: "error"` and return the boundary request Pi would dispatch with
 * `outcome: "error"`.
 */
export function driveErrorTurn(session: FakeSession, errorText: string): BoundaryRequest {
    const entry = session.appendAssistant({ stopReason: "error", errorMessage: errorText });
    return {
        session,
        outcome: "error",
        assistantEntryId: entry.id,
        errorText,
        now: session.now(),
    };
}
