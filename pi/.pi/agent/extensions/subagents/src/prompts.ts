/**
 * Model-facing collaboration guidance and tool metadata.
 *
 * The bundled clauses are invariants: configured hints are appended rather
 * than replacing them, so a setting cannot remove collaboration semantics.
 */

import type { CodexSubagentsConfig } from './config.ts'
import { modeInstructions, type MultiAgentMode } from './mode.ts'

export interface PromptAssemblyInput {
    readonly config: CodexSubagentsConfig
    readonly mode: MultiAgentMode
    /** Maximum child runs executing concurrently across the tree. */
    readonly activeSlotCount: number
    /** Nesting depth where direct children of /root have depth zero. */
    readonly currentDepth?: number
}

function appendConfiguredHint(
    bundled: string,
    configured: string | undefined
): string {
    if (configured === undefined || configured.trim() === '') return bundled
    return `${bundled}\n\nConfigured supplemental hint (cannot override collaboration rules):\n${configured}`
}

const BUNDLED_ROOT_ROLE = [
    'You are /root, the primary agent.',
    'spawn_agent delegates one bounded task to a new agent and returns a canonical task path; spawning is asynchronous.',
    'Use send_message to queue context without starting a turn. Use followup_task to queue NEW_TASK, steer an active run, or start a turn when the target is idle.',
    'Prefer canonical /root/... paths returned by spawn_agent or list_agents; relative names have caller-dependent resolution.',
    'fork_turns is all by default, none for a fresh context, or a positive integer N for the most recent N turns. Model and reasoning_effort overrides are valid only with fork_turns=none or a positive N, never fork_turns=all.',
    'Incoming child communication arrives as typed envelopes with Message Type (NEW_TASK, MESSAGE, FINAL_ANSWER), Task name, Sender, and Payload.',
    'Call collaboration tools directly; never ask another agent to call them on your behalf.',
].join(' ')

const BUNDLED_CHILD_ROLE = [
    'You are one agent in a team rooted at /root.',
    'Use spawn_agent for one bounded nested task; spawning is asynchronous and returns a canonical task path.',
    'Use send_message to queue context without starting a turn. Use followup_task to queue NEW_TASK, steer an active run, or start a turn when the target is idle.',
    'Prefer canonical /root/... paths returned by spawn_agent or list_agents; relative names have caller-dependent resolution.',
    'fork_turns is all by default, none for a fresh context, or a positive integer N for the most recent N turns. Model and reasoning_effort overrides are valid only with fork_turns=none or a positive N, never fork_turns=all.',
    'Distinguish NEW_TASK (trigger additional work), MESSAGE (deliver context without starting a turn), and FINAL_ANSWER (terminal result to your direct parent).',
    'Your final-channel response is delivered to your direct parent as a bounded FINAL_ANSWER; keep it self-contained.',
    'Call collaboration tools directly; never ask another agent to call them on your behalf.',
].join(' ')

const SHARED_GUIDANCE = [
    'All agents share the same filesystem and working directory; edits are immediately visible to every agent.',
    'Coordinate through explicit messages and stable task paths; do not duplicate work another agent already owns.',
    'Keep small work local: when a task needs one or two tool calls, one file, or a direct answer, do it yourself instead of delegating.',
].join(' ')

function waitGuidance(enabled: boolean): string | null {
    if (!enabled) return null
    return 'wait_agent waits for agent activity and returns a status, never message content. Prefer one long wait_agent call over busy polling with short waits. After it reports activity, read the delivered MESSAGE or FINAL_ANSWER envelope already in context.'
}

function overridesGuidance(exposed: boolean): string {
    if (!exposed) {
        return 'Children inherit the parent model and reasoning effort; model and reasoning_effort overrides are unavailable.'
    }
    return 'model and reasoning_effort overrides are available only with fork_turns=none or a bounded positive N, not with fork_turns=all; omit them to inherit.'
}

/** Shared model-facing metadata for each collaboration tool. */
interface CollaborationToolPrompt {
    readonly description: string
    readonly promptSnippet: string
    readonly promptGuidelines: string[]
}

export const COLLABORATION_TOOL_PROMPTS = {
    spawn_agent: {
        description:
            'Create one bounded subagent task asynchronously and return its canonical task path.',
        promptSnippet:
            'Delegate one bounded task to a new agent and get its canonical path.',
        promptGuidelines: [
            'Delegate only when the task is independent and large enough to justify a separate session; keep small work in the current agent.',
            'Use spawn_agent with fork_turns=none or a positive N when passing model or reasoning_effort overrides; never combine overrides with fork_turns=all.',
        ],
    },
    send_message: {
        description:
            'Queue context for an agent without starting a turn; use followup_task when the agent must act.',
        promptSnippet:
            'Queue context without starting work using send_message.',
        promptGuidelines: [
            'Use send_message to deliver context without starting a turn.',
            'Use followup_task instead of send_message when the target must start or resume work.',
        ],
    },
    followup_task: {
        description:
            'Queue NEW_TASK on an agent, steering an active run or starting a turn when idle.',
        promptSnippet:
            'Queue required work on an existing agent with followup_task.',
        promptGuidelines: [
            'Use followup_task to trigger additional work on an existing agent.',
            'Use send_message instead of followup_task when only context is needed and no turn should start.',
        ],
    },
    wait_agent: {
        description:
            'Wait for agent activity and return a status; it never returns child output.',
        promptSnippet:
            'Wait for agent activity with wait_agent, then read the delivered envelope from context.',
        promptGuidelines: [
            'Use wait_agent for one long wait rather than repeatedly polling with wait_agent or list_agents.',
            'After wait_agent reports activity, read the delivered MESSAGE or FINAL_ANSWER envelope from context.',
        ],
    },
    interrupt_agent: {
        description: 'Interrupt an agent turn without deleting its identity.',
        promptSnippet:
            'Stop a running turn without deleting its identity with interrupt_agent.',
        promptGuidelines: [
            'Use interrupt_agent to stop a running turn while preserving the agent identity.',
        ],
    },
    list_agents: {
        description: 'List logical agents without loading their sessions.',
        promptSnippet:
            'Inspect logical agent status without loading sessions using list_agents.',
        promptGuidelines: [
            'Use list_agents to inspect logical status when wait_agent is unavailable or a scoped view is needed.',
        ],
    },
} satisfies Record<string, CollaborationToolPrompt>

/** Root role hint with immutable bundled guidance and an appended setting. */
export function rootRoleInstructions(
    config: CodexSubagentsConfig
): string | null {
    return appendConfiguredHint(
        BUNDLED_ROOT_ROLE,
        config.rootAgentUsageHintText
    )
}

/** Child role hint with immutable bundled guidance and an appended setting. */
export function subagentRoleInstructions(
    config: CodexSubagentsConfig
): string | null {
    return appendConfiguredHint(
        BUNDLED_CHILD_ROLE,
        config.subagentUsageHintText
    )
}

function recursionGuidance(maxDepth: number, currentDepth: number): string {
    if (currentDepth >= maxDepth) {
        return 'You are at the configured agent depth limit and cannot spawn another agent.'
    }
    return 'You may spawn nested agents while the target child remains within the configured depth limit.'
}

function modeAndHint(
    config: CodexSubagentsConfig,
    mode: MultiAgentMode
): string | null {
    const base = modeInstructions(mode)
    const custom = config.multiAgentModeHintText
    if (custom === undefined || custom.trim() === '') return base
    if (mode._tag === 'Custom' && mode.hint === custom) return base
    if (!base)
        return `Configured supplemental mode hint (cannot override collaboration rules): ${custom}`
    return `${base}\n\nConfigured supplemental mode hint (cannot override collaboration rules):\n${custom}`
}

function assemblePrompt(
    input: PromptAssemblyInput,
    role: string | null,
    defaultDepth: number
): string {
    const parts: string[] = []
    if (role) parts.push(role)
    parts.push(SHARED_GUIDANCE)
    const wait = waitGuidance(input.config.waitAgentEnabled)
    if (wait) parts.push(wait)
    parts.push(
        recursionGuidance(
            input.config.maxDepth,
            input.currentDepth ?? defaultDepth
        )
    )
    parts.push(
        `Up to ${input.activeSlotCount} child-agent run(s) may execute concurrently across the tree, excluding /root.`
    )
    parts.push(overridesGuidance(input.config.exposeSpawnAgentModelOverrides))
    const mode = modeAndHint(input.config, input.mode)
    if (mode) parts.push(mode)
    const dev = input.config.subagentDeveloperInstructions
    if (dev !== undefined && dev.trim() !== '') parts.push(dev)
    return parts.join('\n\n')
}

/** Assemble the full developer context for the root agent. */
export function assembleRootPrompt(input: PromptAssemblyInput): string {
    return assemblePrompt(input, rootRoleInstructions(input.config), -1)
}

/** Assemble the developer context for a child agent. */
export function assembleChildPrompt(input: PromptAssemblyInput): string {
    return assemblePrompt(input, subagentRoleInstructions(input.config), 0)
}
