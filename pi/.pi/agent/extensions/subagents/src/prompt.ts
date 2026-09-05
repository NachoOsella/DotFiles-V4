import { COLLABORATION_POLICY } from './collaboration-policy.ts'
import type { AgentEnvelope } from './mailbox.ts'

/** All model-facing strings for the subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION = `Spawn a background child for one bounded task.

The child has its own conversation context and does not know what the parent learned earlier unless that information is included in the task prompt. It may also run a smaller model, so a precise handoff matters.

Use a child only when delegation provides a clear advantage, such as meaningful parallel work, isolated investigation, specialized review, independent validation, or substantial context reduction. Avoid delegation for trivial, tightly coupled, quickly solvable, or mostly sequential work.

Give the child one clear responsibility. Its prompt should transfer all relevant task-specific knowledge already available to the parent and make the expected outcome unambiguous.

When relevant, include the objective, definition of done, established decisions and findings, relevant files or symbols, exact scope, constraints, ownership, expected validation, and what the final report should contain.

Do not send vague prompts that force the child to reconstruct context the parent already has.

The child shares the filesystem with the parent and other children. Keep parallel responsibilities independent and avoid overlapping modifications.

This call is fire-and-forget. After spawning, continue useful independent work. Synchronize with subagent_wait when the child's result becomes relevant to the parent's next step.`
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
    'Delegate one bounded task with a complete handoff of the relevant context you already know'
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [COLLABORATION_POLICY]

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
    prompt: "Complete handoff for the child. The child cannot see the parent's conversation, so include the task-specific context already known by the parent instead of making it rediscover that information. State the concrete objective and expected outcome, and when relevant include established decisions or findings, relevant files or symbols, exact scope and ownership, constraints or invariants, validation to perform, and what the final report should contain. Be specific enough that a capable smaller model can execute the task correctly from this prompt plus the repository alone.",
    name: 'Short name shown in listings and the UI',
    taskName: 'Unique task name. Defaults to name.',
    agentType: 'Child role: default, explorer, worker, reviewer, or tester',
    workingDir: 'Working directory. Defaults to the current directory.',
    model: 'Optional provider/model-id override. Otherwise role configuration or the parent model is used.',
    reasoningEffort:
        'Optional reasoning effort override. Otherwise the configured role effort, role default, or parent effort is used.',
    ownedPaths:
        'Optional paths the child may modify. Overlaps with other workers produce a warning, not a lock.',
}

export function buildSubagentSpawnResult(options: {
    id: string
    taskName?: string
    /** Legacy display name accepted for callers from v1. */
    title?: string
    /** Accepted but intentionally never returned. */
    prompt?: string
    role?: string
    modelLabel: string
    ownershipWarning?: string
}) {
    const warning = options.ownershipWarning
        ? ` Warning: ${options.ownershipWarning}`
        : ''
    if (!options.taskName) {
        return `Spawned ${options.id} "${options.title ?? 'subagent'}" (${options.modelLabel}). It runs in the background; use subagent_wait when its result is needed.${warning}`
    }
    return `Spawned ${options.id} ${options.taskName} (${options.role ?? 'default'}, ${options.modelLabel}).${warning}`
}

export const SUBAGENT_SEND_TOOL_DESCRIPTION = `Send an instruction or answer to an existing child session.

Use this to answer a child's blocking question, clarify its assignment, or assign a subsequent bounded piece of work to the same session.

Prefer follow-up for normal communication. If a child asked a question and stopped its run, answer it with follow-up so it can continue with the parent's decision.

Use steer only when the child is actively working and its current direction needs to change now. Do not use steer for routine updates or information that can wait for the next turn.

When a child asks for a decision, prefer answering through this tool rather than taking over work that still belongs to the child.`
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
    id: 'Subagent id',
    message:
        'Concrete instruction, clarification, or answer for the child. Preserve its existing scope unless you intentionally change the assignment.',
    delivery:
        'follow-up continues the child normally and is the default for answers or additional work; steer redirects an active run immediately and should be reserved for correcting its current direction',
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION = `Synchronize with delegated work when the parent's next meaningful step depends on it.

With ids, wait until the selected children finish, fail, are interrupted, are closed, or one asks a blocking question. A child question returns early without cancelling the other children.

Do not wait immediately after spawning while useful independent parent work remains.

Conversely, do not continue making decisions, editing dependent code, integrating related work, or finishing the parent task after a child's result has become relevant.

Use this at the dependency boundary: continue independent work first, then wait before crossing into work that depends on the delegated result.

Without ids, wait for a new child mailbox message.`
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
    ids: 'Optional subagent ids',
    afterSequence: 'Only return mailbox messages after this sequence',
}

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
    'Compatibility alias for interrupting one or more running subagents.'
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_INTERRUPT_TOOL_DESCRIPTION =
    'Interrupt the current run while keeping each subagent session reusable.'
export const SUBAGENT_INTERRUPT_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_CLOSE_TOOL_DESCRIPTION =
    'Close one or more subagents permanently and release their resources.'
export const SUBAGENT_CLOSE_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
    "Inspect a child's current status and recent activity without consuming its result. Use this for occasional diagnosis or when progress itself matters, not for repeated polling while the child is working normally."
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = { id: 'Subagent id' }
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
    'List running, finished, and closed Pi subagents.'

function envelopeSummary(envelope: AgentEnvelope) {
    const state =
        envelope.kind === 'result'
            ? 'finished'
            : envelope.kind === 'question'
              ? 'asked'
              : envelope.kind === 'gap'
                ? 'gap'
                : envelope.kind
    return `- ${envelope.agentId} ${envelope.taskName} (${envelope.role}) ${state}: ${envelope.text}`
}

export function buildMailboxMessage(events: ReadonlyArray<AgentEnvelope>) {
    const isQuestion = events.some((event) => event.kind === 'question')
    const heading = isQuestion
        ? "Subagent question:\nA child needs a parent decision before it can continue. Answer the question through subagent_send when possible instead of taking over the child's assigned work."
        : 'Subagent result:\nDelegated work has completed or changed state. The parent may have continued working since this child started. Reconcile this result with the current repository state and work already completed before acting on it. Do not blindly repeat or overwrite newer work.'
    return `${heading}\n${events.map(envelopeSummary).join('\n')}`
}
