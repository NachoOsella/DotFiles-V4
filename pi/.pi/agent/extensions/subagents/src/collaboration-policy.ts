/** Tool names that let the parent coordinate subagents. */
export const SUBAGENT_ORCHESTRATION_TOOL_NAMES = [
    'subagent_spawn',
    'subagent_send',
    'subagent_wait',
    'subagent_cancel',
    'subagent_interrupt',
    'subagent_close',
    'subagent_check',
    'subagent_list',
] as const

/** The only orchestration tool that enables the parent collaboration policy. */
export const SUBAGENT_SPAWN_TOOL_NAME = 'subagent_spawn'

/** Identifies a tool that must remain unavailable to child sessions. */
export function isSubagentOrchestrationTool(name: string): boolean {
    return (SUBAGENT_ORCHESTRATION_TOOL_NAMES as readonly string[]).includes(
        name
    )
}

/** Focused parent guidance added when subagent_spawn is available. */
export const COLLABORATION_POLICY = `Do local, trivial, tightly coupled, or sequential work yourself. Use subagent_spawn only when worthwhile independent work, specialized investigation or review, validation, parallelism, or context reduction outweighs handoff cost.

Give each child one bounded responsibility and a complete handoff. Name starting files, set a stop condition with a tool-call budget, and forbid walking the full repo. Do not make the child rediscover known facts, and never use a vague prompt when the concrete problem is known.

Children share the filesystem. Keep parallel ownership disjoint and never overwrite, revert, or casually modify another agent's work.

After subagent_spawn, continue useful independent work. At the dependency boundary, use subagent_wait before dependent decisions or integration. Answer blocking child questions through subagent_send with follow-up. Use follow-up for ordinary instructions and queued work; use steer only to redirect active work now. Steer redirects an active run now, while follow-up waits until its run settles, so never use follow-up to correct course. When a child is stuck inside a long tool call, interrupt it before sending.

Integrate and verify child output against the current repository and observed validation. Reconcile stale or conflicting output with newer parent work, and never claim unobserved success.`

/** Returns whether the parent has the spawn tool that makes delegation possible. */
export function hasCollaborationPolicy(tools: Iterable<string>): boolean {
    for (const tool of tools) {
        if (tool === SUBAGENT_SPAWN_TOOL_NAME) return true
    }
    return false
}

/** Returns the policy only for sessions that can spawn subagents. */
export function collaborationPolicyForTools(
    tools: Iterable<string>
): string | undefined {
    return hasCollaborationPolicy(tools) ? COLLABORATION_POLICY : undefined
}
