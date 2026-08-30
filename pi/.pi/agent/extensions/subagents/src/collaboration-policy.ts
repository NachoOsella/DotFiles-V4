/** Tool names that let the parent coordinate subagents. */
export const SUBAGENT_ORCHESTRATION_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_send",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
] as const;

/** The only orchestration tool that enables the parent collaboration policy. */
export const SUBAGENT_SPAWN_TOOL_NAME = "subagent_spawn";

/** Identifies a tool that must remain unavailable to child sessions. */
export function isSubagentOrchestrationTool(name: string): boolean {
  return (SUBAGENT_ORCHESTRATION_TOOL_NAMES as readonly string[]).includes(name);
}

/** Short guidance for a parent that can delegate work. */
export const COLLABORATION_POLICY =
  "Delegate only when independent context, specialization, or parallel work is useful. Keep small, sequential, or overlapping work in the main thread. Give each subagent one self-contained task and separate file ownership. Use the cheapest capable model, then verify and integrate its work."

/** Returns whether the parent has the spawn tool that makes delegation possible. */
export function hasCollaborationPolicy(tools: Iterable<string>): boolean {
  for (const tool of tools) {
    if (tool === SUBAGENT_SPAWN_TOOL_NAME) return true
  }
  return false
}

/** Returns the policy only for sessions that can spawn subagents. */
export function collaborationPolicyForTools(
  tools: Iterable<string>,
): string | undefined {
  return hasCollaborationPolicy(tools) ? COLLABORATION_POLICY : undefined
}
