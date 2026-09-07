/**
 * Formatting helpers (self-contained copies of the v1 shared helpers:
 * context-utilization + activity-status).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./domain.ts";

export interface ContextUtilization {
  /** Current conversation context occupancy; undefined while unknown. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

function usableTokens(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usableCapacity(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function contextPercent(usage: ContextUtilization) {
  const tokens = usableTokens(usage.tokens);
  const capacity = usableCapacity(usage.contextWindow);
  if (tokens === undefined || capacity === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
}

export function formatCompactTokens(count: number) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render `%/capacity`. If occupancy is unknown, retain the useful capacity
 * as `?%/capacity`; with no valid capacity, omit the statistic entirely.
 */
export function formatContextUtilization(usage: ContextUtilization) {
  const capacity = usableCapacity(usage.contextWindow);
  if (capacity === undefined) return "";
  const percent = contextPercent(usage);
  return `${percent === undefined ? "?" : percent}%/${formatCompactTokens(capacity)}`;
}

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
  /** Agents with queued steer/follow-up messages (a display subset of running). */
  queued?: number;
  /** Runs that settled via interruption (legacy public status merges these into error). */
  interrupted?: number;
  closed?: number;
}

const SQUARE = "■";

/**
 * One display bucket per subagent. `needs-answer` and `queued` are display
 * refinements of the running public status; `interrupted` refines the error
 * status via `lastRun.status`. The public status enum is unchanged.
 */
export type SubagentDisplayState =
  | "running"
  | "needs-answer"
  | "queued"
  | "done"
  | "failed"
  | "interrupted"
  | "closed";

/** Snapshot fields the display state depends on (never output text). */
type QuestionSnapshot = Pick<
  SubagentSnapshot,
  "status" | "lastRun" | "queued"
> & {
  readonly hasPendingQuestion?: boolean;
};

/**
 * Whether a running subagent is waiting on a parent decision. Reads only an
 * explicit question source (mailbox-derived) or an explicit read-model flag;
 * never infers questions from output text.
 */
export function hasBlockingQuestion(
  snap: QuestionSnapshot,
  hasPendingQuestion?: (id: string) => boolean,
): boolean {
  if (snap.status !== "running") return false;
  if (snap.hasPendingQuestion === true) return true;
  const id = (snap as { readonly id?: string }).id;
  return id !== undefined && hasPendingQuestion?.(id) === true;
}

export function subagentDisplayState(
  snap: QuestionSnapshot,
  hasPendingQuestion?: (id: string) => boolean,
): SubagentDisplayState {
  switch (snap.status) {
    case "closed":
      return "closed";
    case "done":
      return "done";
    case "error":
      return snap.lastRun?.status === "interrupted"
        ? "interrupted"
        : "failed";
    case "running":
      if (hasBlockingQuestion(snap, hasPendingQuestion)) return "needs-answer";
      if (snap.queued.length > 0) return "queued";
      return "running";
  }
}

export interface SubagentStateCounts {
  running: number;
  queued: number;
  done: number;
  failed: number;
  interrupted: number;
  closed: number;
}

/**
 * Count every subagent in exactly one bucket. Agents showing `needs-answer`
 * count as running (they are still running); interruption and failure share
 * the error public status but count separately via `lastRun.status`.
 */
export function countSubagentStates(
  subs: ReadonlyArray<QuestionSnapshot>,
  hasPendingQuestion?: (id: string) => boolean,
): SubagentStateCounts {
  const counts: SubagentStateCounts = {
    running: 0,
    queued: 0,
    done: 0,
    failed: 0,
    interrupted: 0,
    closed: 0,
  };
  for (const snap of subs) {
    switch (subagentDisplayState(snap, hasPendingQuestion)) {
      case "running":
      case "needs-answer":
        counts.running++;
        break;
      case "queued":
        counts.queued++;
        break;
      case "done":
        counts.done++;
        break;
      case "failed":
        counts.failed++;
        break;
      case "interrupted":
        counts.interrupted++;
        break;
      case "closed":
        counts.closed++;
        break;
    }
  }
  return counts;
}

export function formatActivityStatus(theme: Theme, counts: ActivityCounts) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `${SQUARE} ${counts.running} running`));
  }
  if ((counts.queued ?? 0) > 0) {
    parts.push(theme.fg("muted", `${SQUARE} ${counts.queued} queued`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${SQUARE} ${counts.done} done`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `${SQUARE} ${counts.failed} failed`));
  }
  if ((counts.interrupted ?? 0) > 0) {
    parts.push(
      theme.fg("error", `${SQUARE} ${counts.interrupted} interrupted`)
    );
  }
  if ((counts.closed ?? 0) > 0) {
    parts.push(theme.fg("muted", `${SQUARE} ${counts.closed} closed`));
  }
  parts.push(theme.fg("accent", "/subagents") + theme.fg("dim", " to view"));

  return `${theme.fg("muted", "subagents:")} ${parts.join(theme.fg("dim", " · "))}`;
}
