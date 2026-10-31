/**
 * Codex-style goals for Pi.
 *
 * `/goal <objective>` sets a persistent goal. The engine continues working at
 * Pi's settlement boundary until the goal is genuinely complete, blocked, the
 * user stops it, or a configured budget is spent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGoalsConfig, GoalRuntime } from "./runtime.ts";
import { registerGoalEvents } from "./adapters/pi-events.ts";
import { registerGoalCommands } from "./adapters/pi-commands.ts";
import { registerGoalTools } from "./adapters/pi-tools.ts";

export default function goalsExtension(pi: ExtensionAPI): void {
    const runtime = new GoalRuntime(pi, loadGoalsConfig());
    registerGoalEvents(pi, runtime);
    registerGoalCommands(pi, runtime);
    registerGoalTools(pi, runtime);
}

export { loadGoalsConfig } from "./runtime.ts";
export { GOAL_USAGE } from "./services/goal-controller.ts";
