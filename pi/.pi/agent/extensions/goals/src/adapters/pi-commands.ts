/**
 * `/goal` command adapter.
 *
 * Commands are the only place a user can change goal status. Mutating commands
 * that would race with a running turn are refused while the agent is streaming,
 * except `pause` and `clear`, which are exactly what a user reaches for when a
 * run is going the wrong way.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalHostApi } from "./host.ts";
import { GOAL_USAGE } from "../services/goal-controller.ts";
import type { GoalRuntime } from "../runtime.ts";
import { sendDirective } from "./directive.ts";
import {
    detailLines,
    historyLines,
    notifyGoal,
    renderGoalUi,
} from "./pi-ui.ts";

const SUBCOMMANDS = [
    "status",
    "pause",
    "resume",
    "clear",
    "edit",
    "budget",
    "history",
    "debug",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
    return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** Nearest subcommand within a small edit distance, or null for a real objective. */
function closestSubcommand(value: string): Subcommand | null {
    const needle = value.toLowerCase();
    if (needle.length < 3) return null;
    let best: Subcommand | null = null;
    let bestDistance = 3;
    for (const candidate of SUBCOMMANDS) {
        const distance = editDistance(needle, candidate);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

function editDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const columns = right.length + 1;
    let previous = Array.from({ length: columns }, (_, index) => index);
    for (let row = 1; row < rows; row += 1) {
        const current = new Array<number>(columns);
        current[0] = row;
        for (let column = 1; column < columns; column += 1) {
            const cost = left[row - 1] === right[column - 1] ? 0 : 1;
            current[column] = Math.min(
                (previous[column] ?? 0) + 1,
                (current[column - 1] ?? 0) + 1,
                (previous[column - 1] ?? 0) + cost,
            );
        }
        previous = current;
    }
    return previous[columns - 1] ?? 0;
}

function parseBudgetArgument(raw: string): { ok: true; value: number | null } | { ok: false } {
    const text = raw.trim().toLowerCase();
    if (text === "off" || text === "none" || text === "unlimited" || text === "0") {
        return { ok: true, value: null };
    }
    const parsed = Number(text.replace(/_/g, ""));
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false };
    }
    return { ok: true, value: parsed };
}

async function showStatus(runtime: GoalRuntime, ctx: ExtensionCommandContext): Promise<void> {
    const result = await runtime.run((engine) => engine.view(runtime.context(ctx)));
    if (!result.ok) {
        notifyGoal(ctx, `Could not read goal state: ${result.message}`, "error");
        return;
    }
    renderGoalUi(ctx, result.value.view);
    if (!result.value.view) {
        notifyGoal(ctx, `No goal set.\n\n${GOAL_USAGE}`, "info");
        return;
    }
    notifyGoal(
        ctx,
        detailLines(result.value.view, runtime.config).join("\n"),
        "info",
    );
}

async function createGoal(
    runtime: GoalRuntime,
    ctx: ExtensionCommandContext,
    pi: GoalHostApi,
    objective: string,
): Promise<void> {
    if (!ctx.isIdle()) {
        notifyGoal(ctx, "Finish or interrupt the running turn before setting a goal.", "warning");
        return;
    }
    const result = await runtime.run((engine) =>
        engine.runCommand({
            ...runtime.context(ctx),
            command: {
                type: "create",
                objective,
                budgetTokens: runtime.config.defaultBudgetTokens,
            },
        }),
    );
    if (!result.ok) {
        notifyGoal(ctx, result.message, "error");
        return;
    }
    renderGoalUi(ctx, result.value.view);
    const prompt = result.value.kickoffPrompt;
    const view = result.value.view;
    if (prompt && view) {
        sendDirective(pi, view, prompt, result.value.directiveKind ?? "kickoff", runtime.config.showDirectives);
        notifyGoal(ctx, "Goal created. Working toward it now; /goal pause or Escape stops it.", "info");
        return;
    }
    notifyGoal(ctx, "Goal created.", "info");
}

async function resumeGoal(
    runtime: GoalRuntime,
    ctx: ExtensionCommandContext,
    pi: GoalHostApi,
): Promise<void> {
    if (!ctx.isIdle()) {
        notifyGoal(ctx, "Wait for the current turn to finish before resuming.", "warning");
        return;
    }
    const result = await runtime.run((engine) =>
        engine.runCommand({ ...runtime.context(ctx), command: { type: "resume" } }),
    );
    if (!result.ok) {
        notifyGoal(ctx, result.message, "error");
        return;
    }
    renderGoalUi(ctx, result.value.view);
    const prompt = result.value.kickoffPrompt;
    const view = result.value.view;
    if (prompt && view) {
        sendDirective(pi, view, prompt, "continuation", runtime.config.showDirectives);
        notifyGoal(ctx, "Goal resumed.", "info");
        return;
    }
    notifyGoal(ctx, result.value.message, "info");
}

async function setBudget(
    runtime: GoalRuntime,
    ctx: ExtensionCommandContext,
    pi: GoalHostApi,
    raw: string,
): Promise<void> {
    const parsed = parseBudgetArgument(raw);
    if (!parsed.ok) {
        notifyGoal(ctx, "Usage: /goal budget <positive integer tokens|off>", "error");
        return;
    }
    if (!ctx.isIdle()) {
        notifyGoal(ctx, "Wait for the current turn to finish before changing the budget.", "warning");
        return;
    }
    const result = await runtime.run((engine) =>
        engine.runCommand({
            ...runtime.context(ctx),
            command: { type: "setBudget", budgetTokens: parsed.value },
        }),
    );
    if (!result.ok) {
        notifyGoal(ctx, result.message, "error");
        return;
    }
    renderGoalUi(ctx, result.value.view);
    const view = result.value.view;
    const prompt = result.value.kickoffPrompt;
    if (prompt && view) {
        sendDirective(pi, view, prompt, "continuation", runtime.config.showDirectives);
    }
    notifyGoal(
        ctx,
        parsed.value === null
            ? "Goal budget removed (unlimited)."
            : `Goal budget set to ${parsed.value} tokens.`,
        "info",
    );
}

async function editGoal(
    runtime: GoalRuntime,
    ctx: ExtensionCommandContext,
    pi: GoalHostApi,
): Promise<void> {
    if (!ctx.hasUI) {
        notifyGoal(ctx, "/goal edit needs an interactive session.", "error");
        return;
    }
    if (!ctx.isIdle()) {
        notifyGoal(ctx, "Wait for the current turn to finish before editing the objective.", "warning");
        return;
    }
    const current = await runtime.view(ctx);
    if (!current.ok) {
        notifyGoal(ctx, `Could not read goal state: ${current.message}`, "error");
        return;
    }
    if (!current.value) {
        notifyGoal(ctx, "No goal set. Use /goal <objective>.", "error");
        return;
    }
    const next = await ctx.ui.editor("Edit goal objective", current.value.snapshot.objective);
    if (next === undefined || next.trim() === "") {
        notifyGoal(ctx, "Goal objective unchanged.", "info");
        return;
    }
    const result = await runtime.run((engine) =>
        engine.runCommand({
            ...runtime.context(ctx),
            command: { type: "edit", objective: next },
        }),
    );
    if (!result.ok) {
        notifyGoal(ctx, result.message, "error");
        return;
    }
    renderGoalUi(ctx, result.value.view);
    const view = result.value.view;
    const prompt = result.value.kickoffPrompt;
    if (prompt && view) {
        sendDirective(pi, view, prompt, "objective-updated", runtime.config.showDirectives);
    }
    notifyGoal(ctx, "Goal objective updated.", "info");
}

async function showHistory(runtime: GoalRuntime, ctx: ExtensionCommandContext): Promise<void> {
    const current = await runtime.view(ctx);
    if (!current.ok) {
        notifyGoal(ctx, `Could not read goal history: ${current.message}`, "error");
        return;
    }
    if (!current.value) {
        notifyGoal(ctx, "No goal set.", "info");
        return;
    }
    notifyGoal(ctx, historyLines(current.value).join("\n"), "info");
}

async function showDebug(runtime: GoalRuntime, ctx: ExtensionCommandContext): Promise<void> {
    const result = await runtime.run((engine) => engine.view(runtime.context(ctx)));
    if (!result.ok) {
        notifyGoal(ctx, `Debug read failed: ${result.message}`, "error");
        return;
    }
    const view = result.value.view;
    const snapshot = view?.snapshot ?? null;
    const debug = {
        config: runtime.config,
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(),
        entryId: result.value.entryId,
        issues: result.value.issues,
        metrics: view?.metrics ?? null,
        goal: snapshot === null
            ? null
            : {
                  ...snapshot,
                  history: snapshot.history.slice(-5),
              },
    };
    notifyGoal(ctx, JSON.stringify(debug, null, 2), "info");
}

async function handleGoalCommand(
    pi: GoalHostApi,
    runtime: GoalRuntime,
    rawArgs: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const args = rawArgs.trim();
    if (args === "") {
        await showStatus(runtime, ctx);
        return;
    }

    const [head, ...rest] = args.split(/\s+/);
    const tail = rest.join(" ").trim();

    if (!isSubcommand(head)) {
        const suggestion = closestSubcommand(head);
        if (suggestion !== null) {
            notifyGoal(ctx, `Unknown subcommand "${head}". Did you mean /goal ${suggestion}?`, "error");
            return;
        }
        await createGoal(runtime, ctx, pi, args);
        return;
    }

    switch (head) {
        case "status":
            await showStatus(runtime, ctx);
            return;
        case "history":
            await showHistory(runtime, ctx);
            return;
        case "debug":
            await showDebug(runtime, ctx);
            return;
        case "budget":
            if (tail === "") {
                notifyGoal(ctx, "Usage: /goal budget <positive integer tokens|off>", "error");
                return;
            }
            await setBudget(runtime, ctx, pi, tail);
            return;
        case "edit":
            await editGoal(runtime, ctx, pi);
            return;
        case "resume":
            await resumeGoal(runtime, ctx, pi);
            return;
        case "pause": {
            const result = await runtime.run((engine) =>
                engine.runCommand({
                    ...runtime.context(ctx),
                    command: { type: "pause", detail: tail === "" ? undefined : tail },
                }),
            );
            if (!result.ok) {
                notifyGoal(ctx, result.message, "error");
                return;
            }
            renderGoalUi(ctx, result.value.view);
            notifyGoal(ctx, "Goal paused. /goal resume continues it.", "info");
            return;
        }
        case "clear": {
            const result = await runtime.run((engine) =>
                engine.runCommand({ ...runtime.context(ctx), command: { type: "clear" } }),
            );
            if (!result.ok) {
                notifyGoal(ctx, result.message, "error");
                return;
            }
            renderGoalUi(ctx, null);
            notifyGoal(ctx, "Goal cleared.", "info");
            return;
        }
    }
}

/** Register `/goal` and its argument completions. */
export function registerGoalCommands(pi: GoalHostApi, runtime: GoalRuntime): void {
    pi.registerCommand("goal", {
        description: "Set, inspect, and control an autonomous goal",
        getArgumentCompletions: (prefix) => {
            const trimmed = prefix.trimStart();
            if (trimmed.includes(" ")) return null;
            const matches = SUBCOMMANDS.filter((name) => name.startsWith(trimmed));
            if (matches.length === 0) return null;
            return matches.map((name) => ({ value: name, label: name }));
        },
        handler: async (args, ctx) => {
            await handleGoalCommand(pi, runtime, args, ctx);
        },
    });
}
