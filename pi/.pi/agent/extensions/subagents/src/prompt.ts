import { COLLABORATION_POLICY } from './collaboration-policy.ts'
import type { AgentEnvelope } from './mailbox.ts'

/** All model-facing strings for the subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION = `Start one background child session for a bounded task.
Use subagent_spawn when worthwhile independent work, review, investigation, validation, or parallelism outweighs handoff cost. Keep trivial and tightly coupled work in the parent.`
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
    'Use subagent_spawn for worthwhile bounded work with a complete handoff'
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [COLLABORATION_POLICY]

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
    prompt: "Complete child handoff. Include the objective, known context and findings, starting files, owned paths, constraints, acceptance, stop condition with tool-call budget, validation, and final-report requirements. Name the files to start from and forbid walking the full repo. The child cannot see the parent's conversation.",
    name: 'Short display name',
    taskName: 'Unique task name; defaults to name',
    agentType: 'Child role: default, explorer, worker, reviewer, or tester',
    workingDir: 'Working directory; defaults to the current directory',
    model: 'Optional model override; otherwise role or parent configuration applies',
    reasoningEffort:
        'Optional effort override; otherwise configured role effort, role default, or parent effort applies',
    ownedPaths: 'Paths this child may modify; overlap warns but does not lock',
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

export const SUBAGENT_SEND_TOOL_DESCRIPTION = `Communicate with an existing child session.
Use subagent_send with follow-up for answers, ordinary instructions, and queued work. Use steer only to redirect an active run immediately. Follow-up is queued and read only after the current run settles, so never use it to correct course mid-run. When the child is stuck inside a long tool call, interrupt it first and then send. Answer blocking questions here instead of taking over the child's assignment.`
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
    id: 'Subagent id',
    message:
        'Instruction, clarification, or answer; preserve scope unless changing it',
    delivery:
        'follow-up resumes normal work and is the default; steer redirects an active run',
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION = `Synchronize with delegated work before a dependent decision or integration.
With ids, wait for completion, failure, interruption, closure, or a blocking question. Without ids, wait for the next child mailbox message.`
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
    ids: 'Optional subagent ids',
    afterSequence: 'Only return mailbox messages after this sequence',
}

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
    'Compatibility alias for interrupting running subagents.'
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_INTERRUPT_TOOL_DESCRIPTION =
    'Interrupt the current run while keeping the session reusable.'
export const SUBAGENT_INTERRUPT_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_CLOSE_TOOL_DESCRIPTION =
    'Close subagents permanently and release their resources.'
export const SUBAGENT_CLOSE_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
    "Inspect a child's status and recent activity without consuming its result. Use subagent_check for occasional diagnosis, not routine polling."
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = { id: 'Subagent id' }
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
    'List running, finished, and closed Pi subagents.'

function envelopeSummary(envelope: AgentEnvelope) {
    const state =
        envelope.kind === 'result'
            ? 'finished'
            : envelope.kind === 'question'
              ? 'asked'
              : envelope.kind === 'update'
                ? 'shared an update'
                : envelope.kind === 'gap'
                  ? 'gap'
                  : envelope.kind
    return `- ${envelope.agentId} ${envelope.taskName} (${envelope.role}) ${state}: ${envelope.text}`
}

export function buildMailboxMessage(events: ReadonlyArray<AgentEnvelope>) {
    const isQuestion = events.some((event) => event.kind === 'question')
    const allUpdates =
        events.length > 0 && events.every((event) => event.kind === 'update')
    const heading = isQuestion
        ? "Subagent question:\nA child needs a parent decision before it can continue. Answer the question through subagent_send when possible instead of taking over the child's assigned work."
        : allUpdates
          ? 'Subagent update:\nA child shared progress while it keeps working. Read it and continue your own work when possible. Use subagent_send with steer to redirect it now, or follow-up to queue guidance for its next turn.'
          : 'Subagent result:\nDelegated work has completed or changed state. The parent may have continued working since this child started. Reconcile this result with the current repository state and work already completed before acting on it. Do not blindly repeat or overwrite newer work.'
    return `${heading}\n${events.map(envelopeSummary).join('\n')}`
}
