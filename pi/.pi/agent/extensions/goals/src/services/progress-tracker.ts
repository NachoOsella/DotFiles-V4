/**
 * Turn progress derived from the transcript branch.
 *
 * A goal turn starts at a goal directive, so counters only see entries after
 * the goal existed. Everything here is pure: the circuit breaker and the
 * completion gate read these numbers, they never write state.
 */
import {
    GOAL_DIRECTIVE_CUSTOM_TYPE,
    GOAL_SNAPSHOT_CUSTOM_TYPE,
    readDirectiveDetails,
    type GoalDirectiveDetails,
    type TranscriptEntry,
} from "../domain/goal.ts";

/** Tool categories used for progress accounting. */
export type ToolCategory = "goal" | "read" | "mutate" | "command" | "other";

/** Goal tools: their results never count as progress evidence. */
const GOAL_TOOLS = new Set(["get_goal", "create_goal", "update_goal"]);

/** Verified against `dist/core/tools/index.d.ts` (`ToolName`) in pi 1.4.0. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATE_TOOLS = new Set(["write", "edit"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

/** Per-goal counters derived at one observation point. */
export interface TurnStats {
    readonly goalTurns: number;
    readonly continuationCount: number;
    readonly wrapupCount: number;
    readonly toolCalls: number;
    readonly failedToolCalls: number;
    readonly currentTurnEvidence: number;
    readonly currentTurnMutated: boolean;
    readonly idleTurns: number;
    readonly directivePending: boolean;
    readonly lastDirectiveEntryId: string | null;
    readonly lastDirectiveAnchorId: string | null;
}

export function isGoalTool(toolName: string | undefined): boolean {
    return toolName !== undefined && GOAL_TOOLS.has(toolName);
}

export function summarizeToolName(toolName: string | undefined): ToolCategory {
    if (toolName === undefined) return "other";
    if (GOAL_TOOLS.has(toolName)) return "goal";
    if (READ_TOOLS.has(toolName)) return "read";
    if (MUTATE_TOOLS.has(toolName)) return "mutate";
    if (COMMAND_TOOLS.has(toolName)) return "command";
    return "other";
}

/**
 * Per-turn counters.
 *
 * `activity` is any successful non-goal tool result and feeds the no-progress
 * breaker, so planning or delegation tools still count as work. `evidence` is
 * narrower: only tools that can verify current state (read/search, write/edit,
 * shell) and feeds the completion gate, so a plan update cannot prove done.
 */
interface TurnAccumulator {
    activity: number;
    evidence: number;
    mutated: boolean;
}

interface ToolResultFacts {
    readonly toolName: string | undefined;
    readonly isError: boolean;
}

/** Matching goal directives, in branch order. */
interface GoalDirective {
    readonly index: number;
    readonly entryId: string;
    readonly details: GoalDirectiveDetails;
}

/**
 * Derive turn-level progress for one goal.
 *
 * A goal turn starts at a goal directive for `goalId`. A goal created by the
 * `create_goal` tool has no directive yet: its first turn starts at the creation
 * snapshot, so the work done in that turn still counts as evidence. Tool calls
 * from before the goal existed are ignored entirely.
 */
export function deriveTurnStats(branch: readonly TranscriptEntry[], goalId: string): TurnStats {
    const directives = collectDirectives(branch, goalId);
    const creationIndex = directives.length === 0 ? findCreationIndex(branch, goalId) : -1;
    // An objective edit steers the running goal; it does not start a new goal turn.
    const turnDirectives = directives.filter(
        (directive) => directive.details.kind !== "objective-updated",
    );
    const turnStarts =
        turnDirectives.length > 0
            ? turnDirectives.map((directive) => directive.index)
            : creationIndex >= 0
              ? [creationIndex]
              : [];

    const turns: TurnAccumulator[] = [];
    let startCursor = 0;
    let turnIndex = -1;
    let toolCalls = 0;
    let failedToolCalls = 0;

    for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index];

        if (startCursor < turnStarts.length && turnStarts[startCursor] === index) {
            startCursor += 1;
            turnIndex += 1;
            turns.push({ activity: 0, evidence: 0, mutated: false });
        }

        if (turnIndex < 0) continue;

        const result = readToolResult(entry);
        if (result === null) continue;

        toolCalls += 1;
        if (result.isError) {
            failedToolCalls += 1;
            continue;
        }
        if (isGoalTool(result.toolName)) continue;

        const turn = turns[turnIndex];
        turn.activity += 1;
        const category = summarizeToolName(result.toolName);
        if (category === "read" || category === "mutate" || category === "command") {
            turn.evidence += 1;
        }
        if (category === "mutate") turn.mutated = true;
    }

    const lastDirective =
        turnDirectives.length === 0 ? null : turnDirectives[turnDirectives.length - 1];
    const currentTurn = turns.length === 0 ? null : turns[turns.length - 1];

    let continuationCount = 0;
    let wrapupCount = 0;
    for (const directive of directives) {
        if (directive.details.kind === "continuation") continuationCount += 1;
        if (directive.details.kind === "budget-wrapup") wrapupCount += 1;
    }

    const directivePending = lastDirective !== null && lastDirective.index === branch.length - 1;

    // A trailing directive that was never answered is not an idle turn: the run
    // may have been aborted before it started, so it must not feed the breaker.
    let idleTurns = 0;
    const scanFrom = directivePending ? turns.length - 2 : turns.length - 1;
    for (let index = scanFrom; index >= 0; index -= 1) {
        if (turns[index].activity > 0) break;
        idleTurns += 1;
    }

    return {
        goalTurns: Math.max(turnDirectives.length, turns.length > 0 ? 1 : 0),
        continuationCount,
        wrapupCount,
        toolCalls,
        failedToolCalls,
        currentTurnEvidence: currentTurn?.evidence ?? 0,
        currentTurnMutated: currentTurn?.mutated ?? false,
        idleTurns,
        directivePending,
        lastDirectiveEntryId: lastDirective?.entryId ?? null,
        lastDirectiveAnchorId: lastDirective?.details.anchorEntryId ?? null,
    };
}

/** Collect goal directives for `goalId`; malformed details are ignored. */
function collectDirectives(branch: readonly TranscriptEntry[], goalId: string): GoalDirective[] {
    const directives: GoalDirective[] = [];
    for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index];
        if (entry.type !== "custom_message") continue;
        if (entry.customType !== GOAL_DIRECTIVE_CUSTOM_TYPE) continue;
        const details = readDirectiveDetails(entry.details);
        if (details === null || details.goalId !== goalId) continue;
        directives.push({ index, entryId: entry.id, details });
    }
    return directives;
}

/** Index of the goal's creation snapshot, or -1 when it is not on the branch. */
function findCreationIndex(branch: readonly TranscriptEntry[], goalId: string): number {
    for (let index = 0; index < branch.length; index += 1) {
        const entry = branch[index];
        if (entry.type !== "custom" || entry.customType !== GOAL_SNAPSHOT_CUSTOM_TYPE) continue;
        const data = entry.data;
        if (typeof data !== "object" || data === null) continue;
        const value: unknown = Reflect.get(data, "goalId");
        if (value === goalId) return index;
    }
    return -1;
}

/** Tool result facts for one entry, or null when it is not a tool result. */
function readToolResult(entry: TranscriptEntry): ToolResultFacts | null {
    if (entry.type !== "message") return null;
    const message = entry.message;
    if (message === undefined || message.role !== "toolResult") return null;
    return { toolName: message.toolName, isError: message.isError === true };
}
