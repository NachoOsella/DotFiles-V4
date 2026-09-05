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

/** Complete parent guidance for when and how to delegate well. */
export const COLLABORATION_POLICY = `Default to doing the work yourself. Delegate only when a child provides a clear advantage through meaningful parallelism, isolated context, specialized investigation or review, independent validation, or substantial context reduction. Parallelizable does not automatically mean worth delegating.

Do not delegate trivial, quickly solvable, tightly coupled, or mostly sequential work. Do not spawn a child for work whose result you need immediately unless no useful independent work can proceed.

Treat every spawn as a handoff to an agent that does not have your conversation context and may be using a smaller model. The quality of the child's work depends heavily on the quality of that handoff.

Before spawning, transfer the task-specific context you already know. Do not make the child rediscover facts, decisions, requirements, file locations, constraints, or conclusions that you have already established.

A good child prompt should make the intended result unambiguous. Include the following when relevant:
- the exact objective and what counts as done;
- important context, decisions, assumptions, or findings already established;
- relevant files, symbols, components, commands, or execution paths already known;
- the child's exact scope and ownership;
- constraints, invariants, and things that must not change;
- what the child should inspect, implement, review, or validate;
- validation expected before completion;
- what information the final report must contain.

Use judgment rather than mechanically filling a template. Include information because it helps the child perform the task correctly, not to make the prompt longer. A smaller but complete handoff is better than a long generic one.

Never delegate with a vague instruction such as "investigate this", "fix this", "review this", or "look at X" when you already know enough to state the concrete problem and expected outcome.

Give each child one bounded responsibility. When several children run in parallel, keep their responsibilities independent and avoid overlapping file ownership. All agents share the filesystem, so never overwrite, revert, or casually modify work owned by another active agent.

After spawning, continue useful independent work instead of immediately waiting. However, do not continue past the point where the child's result becomes relevant to your next decision or implementation step. At that synchronization point, use subagent_wait and incorporate the result before proceeding.

A child question is a request for a decision, not an invitation to take over its task. Answer the child with subagent_send when possible and let it continue its assigned work. Take over or reassign the work only when there is a concrete reason to do so.

Use normal follow-up delivery for answers and additional work. Use steer only when an active child is proceeding in the wrong direction and needs its current run redirected.

The parent remains responsible for integration and correctness. Reconcile child results with the current repository state, verify important claims, and run the appropriate final validation before presenting the task as complete.`

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
