/**
 * Pi lifecycle wiring.
 *
 * `agent_before_settle` is the single continuation site. Everything else here
 * observes and persists; nothing else is allowed to request another model turn.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalHostApi } from "./host.ts";
import type { TranscriptEntry, TranscriptMessage } from "../domain/goal.ts";
import type { GoalRuntime } from "../runtime.ts";
import { buildDirectiveDraft } from "./directive.ts";
import { notifyGoal, renderGoalUi } from "./pi-ui.ts";

/** Newest assistant entry on the branch, used as the boundary anchor. */
export function lastAssistantEntry(branch: readonly TranscriptEntry[]): TranscriptEntry | null {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type === "message" && entry.message?.role === "assistant") {
            return entry;
        }
    }
    return null;
}

function providerErrorText(message: TranscriptMessage | undefined): string | null {
    if (!message) return null;
    if (message.stopReason !== "error") return null;
    const text = message.errorMessage?.trim();
    return text && text.length > 0 ? text : "provider error";
}

/**
 * The installed Pi 1.4 runtime emits `aborted`, but the workspace's 1.0 typings
 * (which `tsc` resolves) do not declare it. Read the field structurally so the
 * code typechecks against both; the `^1.4.0` peer range guarantees the runtime
 * that actually provides it.
 */
function settledAborted(event: object): boolean {
    return "aborted" in event && event.aborted === true;
}

export function registerGoalEvents(pi: GoalHostApi, runtime: GoalRuntime): void {
    pi.on("session_start", async (event, ctx) => {
        const result = await runtime.run((engine) =>
            engine.rehydrate({ ...runtime.context(ctx), reason: event.reason }),
        );
        if (!result.ok) {
            notifyGoal(ctx, `Goal state could not be restored: ${result.message}`, "error");
            return;
        }
        renderGoalUi(ctx, result.value.view);
        const issues = await runtime.run((engine) => engine.view(runtime.context(ctx)));
        if (issues.ok && issues.value.issues.length > 0) {
            notifyGoal(
                ctx,
                "Ignored an invalid goal snapshot from this session; an older valid one was restored.",
                "warning",
            );
        }
    });

    pi.on("session_tree", async (_event, ctx) => {
        const result = await runtime.run((engine) =>
            engine.rehydrate({ ...runtime.context(ctx), reason: "tree" }),
        );
        if (result.ok) {
            renderGoalUi(ctx, result.value.view);
        } else {
            notifyGoal(ctx, `Goal state could not be restored after tree navigation: ${result.message}`, "error");
        }
    });

    pi.on("agent_start", async () => {
        runtime.beginRun();
    });

    pi.on("agent_settled", async (event, ctx) => {
        const aborted = settledAborted(event);
        const activeMsDelta = runtime.endRun();
        if (aborted) {
            runtime.markInterrupt();
        }
        const result = await runtime.run((engine) =>
            engine.settle({
                ...runtime.context(ctx),
                aborted,
                activeMsDelta,
            }),
        );
        if (!result.ok) {
            notifyGoal(ctx, `Goal bookkeeping failed: ${result.message}`, "error");
            return;
        }
        renderGoalUi(ctx, result.value.view);
        if (result.value.notice) {
            notifyGoal(ctx, result.value.notice, "info");
        }
    });

    pi.on("agent_before_settle", async (event, ctx) => {
        const branch = ctx.sessionManager.getBranch();
        const assistant = lastAssistantEntry(branch);
        const decision = await runtime.run((engine) =>
            engine.decideBoundary({
                ...runtime.context(ctx),
                facts: {
                    now: Date.now(),
                    outcome: event.outcome,
                    assistantEntryId: assistant?.id ?? null,
                    errorText: providerErrorText(assistant?.message),
                },
            }),
        );
        if (!decision.ok) {
            // Never leave a goal `active` with nothing driving it.
            const safe = await runtime.run((engine) =>
                engine.failSafe({ ...runtime.context(ctx), detail: decision.message }),
            );
            if (safe.ok) renderGoalUi(ctx, safe.value.view);
            notifyGoal(
                ctx,
                `Goal decision failed: ${decision.message}. ${safe.ok ? "The goal was paused." : "The goal could not be paused; run /goal pause."}`,
                "error",
            );
            return undefined;
        }

        const value = decision.value;
        renderGoalUi(ctx, value.view);

        switch (value.kind) {
            case "continue": {
                const draft = buildDirectiveDraft(
                    value.view,
                    value.prompt,
                    value.directiveKind,
                    assistant?.id ?? null,
                    runtime.config.showDirectives,
                );
                return { entries: [...event.entries, draft], continue: true };
            }
            case "budget-wrapup": {
                const draft = buildDirectiveDraft(
                    value.view,
                    value.prompt,
                    "budget-wrapup",
                    assistant?.id ?? null,
                    runtime.config.showDirectives,
                );
                return { entries: [...event.entries, draft], continue: true };
            }
            case "stopped": {
                notifyGoal(ctx, value.notice, "warning");
                return undefined;
            }
            case "idle": {
                return undefined;
            }
        }
    });

    // `/compact` aborts the running turn before it emits this event, so the goal
    // may have just been paused as if the user interrupted it. Pi exposes no
    // causal link, and silently resuming could restart work the user stopped on
    // purpose, so only explain the situation and let the user decide.
    pi.on("session_before_compact", async (event, ctx) => {
        if (event.reason !== "manual") return;
        if (!runtime.hasRecentInterrupt()) return;
        runtime.clearInterrupt();
        notifyGoal(
            ctx,
            "Goal is paused after the interrupt that preceded this /compact. Run /goal resume to continue it.",
            "info",
        );
    });

    // Do not dispose the engine runtime here: Pi emits `session_shutdown` before
    // it aborts and settles an in-flight run, so disposing now would make the
    // final settle fail. The runtime holds no resources that need releasing.
    pi.on("session_shutdown", async () => {
        runtime.detach();
    });
}
