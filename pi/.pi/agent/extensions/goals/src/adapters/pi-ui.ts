/**
 * Terminal UI for goal state.
 *
 * Everything here is best-effort: non-interactive modes have no status line or
 * widget, and a UI failure must never break the goal loop.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalView } from "../domain/goal.ts";
import type { GoalsConfig } from "../runtime.ts";

const STATUS_KEY = "goal";
const WIDGET_KEY = "goal";

function shortNumber(value: number): string {
    if (value < 1000) return String(value);
    if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
    return `${(value / 1_000_000).toFixed(2)}M`;
}

function duration(ms: number): string {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
}

/** One-line status for the footer. */
export function statusLine(view: GoalView | null): string {
    if (!view) return "";
    const { snapshot, metrics } = view;
    const budget =
        snapshot.budgetTokens === null
            ? `${shortNumber(metrics.usage.tokensUsed)}`
            : `${shortNumber(metrics.usage.tokensUsed)}/${shortNumber(snapshot.budgetTokens)}`;
    const suffix = snapshot.status === "active" ? "" : ` ${snapshot.status}`;
    return `goal${suffix} ${budget} · ${metrics.continuationCount}c · ${duration(snapshot.activeMs)}`;
}

/** Compact widget lines: objective, state, metrics. */
export function widgetLines(view: GoalView | null): string[] {
    if (!view) return [];
    const { snapshot, metrics } = view;
    const objective = snapshot.objective.replace(/\s+/g, " ").trim();
    const clipped = objective.length > 96 ? `${objective.slice(0, 93)}...` : objective;
    const budget =
        snapshot.budgetTokens === null
            ? "unbounded"
            : `${shortNumber(metrics.usage.tokensUsed)}/${shortNumber(snapshot.budgetTokens)} (${shortNumber(metrics.remainingTokens ?? 0)} left)`;
    const details = [
        `status ${snapshot.status}`,
        `tokens ${budget}`,
        `turns ${metrics.goalTurns}`,
        `tools ${metrics.toolCalls}`,
        `active ${duration(snapshot.activeMs)}`,
    ];
    if (snapshot.pause) details.push(`pause ${snapshot.pause.reason}`);
    return [`goal: ${clipped}`, details.join(" · ")];
}

/** Update status line and widget for the current view. */
export function renderGoalUi(ctx: ExtensionContext, view: GoalView | null): void {
    try {
        const line = statusLine(view);
        ctx.ui.setStatus(STATUS_KEY, line === "" ? undefined : line);
        if (ctx.mode === "tui") {
            const lines = widgetLines(view);
            ctx.ui.setWidget(WIDGET_KEY, lines.length === 0 ? undefined : lines, {
                placement: "aboveEditor",
            });
        }
    } catch {
        // Rendering is advisory.
    }
}

/** Notify without letting a UI error break the caller. */
export function notifyGoal(
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
): void {
    try {
        ctx.ui.notify(message, type);
    } catch {
        // Notifications are advisory.
    }
}

/** Multi-line detail block used by `/goal status` and `/goal history`. */
export function detailLines(view: GoalView, config: GoalsConfig): string[] {
    const { snapshot, metrics } = view;
    const lines = [
        `Goal ${snapshot.goalId}`,
        `Objective: ${snapshot.objective}`,
        `Status: ${snapshot.status}`,
        `Tokens: ${metrics.usage.tokensUsed} charged (${metrics.usage.input} in, ${metrics.usage.output} out, ${metrics.usage.cacheWrite} cache write, ${metrics.usage.cacheRead} cache read)`,
        `Budget: ${snapshot.budgetTokens === null ? "unbounded" : `${snapshot.budgetTokens} (${metrics.remainingTokens ?? 0} left)`}`,
        `Turns: ${metrics.goalTurns} · continuations ${metrics.continuationCount} · wrap-ups ${metrics.wrapupCount}`,
        `Tools: ${metrics.toolCalls} calls, ${metrics.failedToolCalls} failed · evidence this turn ${metrics.currentTurnEvidence}`,
        `Active time: ${duration(snapshot.activeMs)}`,
        `Idle turns: ${metrics.idleTurns}/${config.maxIdleTurns} · max turns ${config.maxGoalTurns}`,
        `Created: ${new Date(snapshot.createdAt).toISOString()} · updated: ${new Date(snapshot.updatedAt).toISOString()}`,
    ];
    if (snapshot.pause) {
        lines.push(
            `Paused: ${snapshot.pause.reason}${snapshot.pause.detail ? ` (${snapshot.pause.detail})` : ""}`,
        );
    }
    if (snapshot.block) {
        lines.push(
            `Blocked: ${snapshot.block.reason}${snapshot.block.evidence.length > 0 ? ` [${snapshot.block.evidence.join("; ")}]` : ""}`,
        );
    }
    return lines;
}

/** History lines, newest last. */
export function historyLines(view: GoalView): string[] {
    if (view.snapshot.history.length === 0) return ["No history recorded."];
    return view.snapshot.history.map((entry) => {
        const at = new Date(entry.at).toISOString().slice(11, 19);
        const transition = `${entry.from ?? "none"} -> ${entry.to}`;
        return `${at} ${transition} (${entry.reason})${entry.detail ? `: ${entry.detail}` : ""}`;
    });
}
