import { COLLABORATION_POLICY } from './collaboration-policy.ts'
import type { AgentEnvelope } from './mailbox.ts'

/** All model-facing strings for the subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION = `Spawn a background child for one bounded task.

Spawning has coordination and context cost. Use it only when the expected benefit clearly exceeds doing the work directly.

Good reasons: meaningful parallel work, isolated context, specialized review or validation, or substantial context reduction.
Bad reasons: trivial edits, one or two quick searches, tightly coupled work, or work whose result is immediately required.

Use one assistant for a bounded independent task. Use orchestration only for multiple substantial independent workstreams. The child shares the filesystem with the parent.`
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
    'Delegate a bounded task only when it has a clear advantage over doing it directly'
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [COLLABORATION_POLICY]

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
    prompt: 'Self-contained task and report request',
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

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
    'Send a concise instruction to a child. Follow-up queues normal work without interrupting it; use steer only to redirect an active task.'
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
    id: 'Subagent id',
    message: 'Instruction for the child',
    delivery:
        'follow-up queues a normal next turn (default); steer redirects an active run',
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
    'Wait until all listed children finish, fail, are interrupted, or are closed. With ids, return early when one asks a question and include the still-pending children without cancelling them. Without ids, wait for a new child mailbox message.'
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
    "Peek at a subagent's status and recent activity."
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
    const heading = events.some((event) => event.kind === 'question')
        ? 'Subagent messages:'
        : 'Subagent updates:'
    return `${heading}\n${events.map(envelopeSummary).join('\n')}`
}
