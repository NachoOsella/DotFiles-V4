import { COLLABORATION_POLICY } from './collaboration-policy.ts'
import type { AgentEnvelope } from './mailbox.ts'

/** All model-facing strings for the subagent tools. */

export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
    'Spawn a background child for a self-contained task. Max 8 can run at once.'
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
    'Delegate a self-contained task to a background subagent'
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [COLLABORATION_POLICY]

export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
    prompt: 'Self-contained task and report request',
    name: 'Short name shown in listings and the UI',
    taskName: 'Unique task name. Defaults to name.',
    agentType: 'Child role: default, explorer, worker, reviewer, or tester',
    workingDir: 'Working directory. Defaults to the current directory.',
    model: 'Model hint. Defaults to the role or parent model.',
    reasoningEffort: 'Reasoning effort. Defaults to the role or parent level.',
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
}) {
    if (!options.taskName) {
        return `Spawned ${options.id} "${options.title ?? 'subagent'}" (${options.modelLabel}). It runs in the background; use subagent_wait when its result is needed.`
    }
    return `Spawned ${options.id} ${options.taskName} (${options.role ?? 'default'}, ${options.modelLabel}).`
}

export const SUBAGENT_SEND_TOOL_DESCRIPTION =
    'Send a concise instruction to a child.'
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
    id: 'Subagent id',
    message: 'Instruction for the child',
    delivery: 'steer redirects an active run; follow-up waits for it to settle',
}

export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
    'Wait for listed children, or for new child mailbox messages when ids are omitted.'
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
    ids: 'Optional subagent ids',
    timeoutMs: 'Optional mailbox wait timeout in milliseconds',
    afterSequence: 'Only return mailbox messages after this sequence',
}

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
    'Cancel one or more running subagents.'
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = { ids: 'Subagent ids' }
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
    "Peek at a subagent's status and recent activity."
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = { id: 'Subagent id' }
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
    'List running and finished Pi subagents.'

function envelopeSummary(envelope: AgentEnvelope) {
    const state =
        envelope.kind === 'result'
            ? 'finished'
            : envelope.kind === 'question'
              ? 'asked'
              : envelope.kind
    return `- ${envelope.agentId} ${envelope.taskName} (${envelope.role}) ${state}: ${envelope.text}`
}

export function buildMailboxMessage(events: ReadonlyArray<AgentEnvelope>) {
    const heading = events.some((event) => event.kind === 'question')
        ? 'Subagent messages:'
        : 'Subagent updates:'
    return `${heading}\n${events.map(envelopeSummary).join('\n')}`
}
