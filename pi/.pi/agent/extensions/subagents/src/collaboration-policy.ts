/** Tool names that let the parent coordinate subagents. */
export const SUBAGENT_ORCHESTRATION_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_send",
  "subagent_wait",
  "subagent_cancel",
  "subagent_interrupt",
  "subagent_close",
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
  "Default to doing the work yourself. Delegate only when it provides a clear advantage through meaningful parallelism, independent context, specialization, or context reduction. Parallelizable does not automatically mean worth delegating. Do not delegate small, sequential, tightly coupled, or quickly solvable work, or work whose result you would immediately wait for. Use one bounded assistant while continuing useful work; orchestrate only multiple substantial independent workstreams. Give each subagent one self-contained task with clear ownership. All agents share the filesystem: never overwrite, revert, or modify unrelated parallel work. Verify and integrate delegated work yourself before presenting it as complete."

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
