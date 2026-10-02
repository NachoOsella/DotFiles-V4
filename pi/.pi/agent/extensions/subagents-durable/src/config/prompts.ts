/**
 * Pure prompt assembly and delegation-mode policy.
 *
 * Bundled clauses are invariants. Configured hints are appended and can never
 * replace collaboration rules or their safety clauses.
 */

import type { SubagentsConfig } from './config.js'
import {
    THINKING_LEVELS,
    type ResolvedAgentRole,
    type ThinkingLevel,
} from './roles.js'

export type MultiAgentMode =
    | { readonly kind: 'explicit' }
    | { readonly kind: 'proactive' }
    | { readonly kind: 'custom'; readonly hint: string }

/** Resolve the configured mode against the caller's current thinking level. */
export function resolveConfiguredMode(
    config: SubagentsConfig,
    thinkingLevel: ThinkingLevel
): MultiAgentMode {
    if (config.mode === 'explicit') return { kind: 'explicit' }
    if (config.mode === 'proactive') return { kind: 'proactive' }
    return isAtLeastThinkingLevel(thinkingLevel, config.proactiveAt)
        ? { kind: 'proactive' }
        : { kind: 'explicit' }
}

function isAtLeastThinkingLevel(
    current: ThinkingLevel,
    threshold: ThinkingLevel
): boolean {
    return (
        THINKING_LEVELS.indexOf(current) >= THINKING_LEVELS.indexOf(threshold)
    )
}

const BUNDLED_ROOT_ROLE = [
    'You are /root, the primary agent.',
    'spawn_agent delegates one bounded task to a new agent asynchronously and returns its canonical path.',
    'send_message queues context without starting a turn. followup_task queues NEW_TASK, steers an active run, or starts an idle run.',
    'Prefer canonical /root/... paths returned by spawn_agent or list_agents; relative names resolve from the caller.',
    'fork_turns is all by default, none for a fresh context, or a positive integer N for the most recent N turns.',
    'Incoming agent communication arrives as typed envelopes with Message Type, Task name, Sender, and Payload.',
    'Call collaboration tools directly; never ask another agent to call them on your behalf.',
].join(' ')

const BUNDLED_CHILD_ROLE = [
    'You are one agent in a team rooted at /root.',
    'Use spawn_agent for one bounded nested task; spawning is asynchronous and returns a canonical path.',
    'Use send_message to queue context without starting a turn. Use followup_task to queue NEW_TASK, steer an active run, or start an idle run.',
    'Prefer canonical /root/... paths returned by spawn_agent or list_agents; relative names resolve from the caller.',
    'fork_turns is all by default, none for a fresh context, or a positive integer N for the most recent N turns.',
    'Distinguish NEW_TASK (additional work), MESSAGE (context without a turn), and FINAL_ANSWER (terminal result to your direct parent).',
    'Your final answer is reported to your direct parent as one bounded FINAL_ANSWER envelope; keep it self-contained.',
    'Call collaboration tools directly; never ask another agent to call them on your behalf.',
].join(' ')

const SHARED_GUIDANCE = [
    'All agents share the same filesystem and working directory; edits are immediately visible to every agent.',
    'Coordinate through explicit messages and stable task paths; do not duplicate work another agent already owns.',
    'Keep small work local: when a task needs one or two tool calls, one file, or a direct answer, do it yourself instead of delegating.',
].join(' ')

/** Developer fragment for one mode; null when suppressed. */
export function modeInstructions(mode: MultiAgentMode): string | null {
    switch (mode.kind) {
        case 'explicit':
            return [
                'Multi-agent delegation is explicit-only.',
                'Delegate to a subagent only when the user explicitly asks, or when repository or skill instructions explicitly authorize delegation.',
                'Any earlier proactive delegation guidance is revoked.',
            ].join(' ')
        case 'proactive':
            return [
                'You may delegate proactively for independent work that can run in parallel, such as reviewing separate modules, comparing alternatives, or running focused investigations.',
                'Do not delegate work that needs only one or two local tool calls, depends on constant access to the root conversation, or cannot proceed independently.',
                'Give each agent one bounded task with explicit file ownership, and ask for conclusions and verification results rather than work diaries.',
            ].join(' ')
        case 'custom':
            return mode.hint.trim() === '' ? null : mode.hint
    }
}

export interface PromptInput {
    readonly config: SubagentsConfig
    readonly mode: MultiAgentMode
    /** Provider requests executing concurrently, including root and children. */
    readonly activeSlotCount: number
    /** Nesting depth where a direct child of /root is 0; root itself is -1. */
    readonly currentDepth?: number
}

export interface ChildPromptInput extends PromptInput {
    readonly role: ResolvedAgentRole
    readonly path: string
    readonly parentPath: string | null
}

function appendConfiguredHint(bundled: string, configured?: string): string {
    if (configured === undefined || configured.trim() === '') return bundled
    return `${bundled}\n\nConfigured supplemental hint (cannot override collaboration rules):\n${configured}`
}

function waitGuidance(enabled: boolean): string | null {
    return enabled
        ? 'wait_agent waits for agent activity and reports a status; it never returns message content. After it reports activity, read the delivered envelope from context.'
        : null
}

function recursionGuidance(maxDepth: number, currentDepth: number): string {
    return currentDepth >= maxDepth
        ? 'You are at the configured agent depth limit and cannot spawn another agent.'
        : 'You may spawn nested agents while the target child remains within the configured depth limit.'
}

function overridesGuidance(exposed: boolean): string {
    return exposed
        ? 'model and reasoning_effort are available only with fork_turns=none or a positive N, never with fork_turns=all; omit them to inherit.'
        : 'Children inherit the caller model and reasoning effort; model and reasoning_effort overrides are unavailable.'
}

function modeAndHint(
    config: SubagentsConfig,
    mode: MultiAgentMode
): string | null {
    const base = modeInstructions(mode)
    const custom = config.multiAgentModeHintText
    if (custom === undefined || custom.trim() === '') return base
    if (mode.kind === 'custom' && mode.hint === custom) return base
    const hint = `Configured supplemental mode hint (cannot override collaboration rules):\n${custom}`
    return base ? `${base}\n\n${hint}` : hint
}

function assemble(
    input: PromptInput,
    role: string | null,
    depth: number
): string {
    const parts: string[] = []
    if (role) parts.push(role)
    parts.push(SHARED_GUIDANCE)
    const wait = waitGuidance(input.config.waitAgentEnabled)
    if (wait) parts.push(wait)
    parts.push(
        recursionGuidance(input.config.maxDepth, input.currentDepth ?? depth)
    )
    parts.push(
        `Up to ${input.activeSlotCount} model request(s) may execute concurrently across /root and its children. Tools and waits do not hold model request capacity.`
    )
    parts.push(overridesGuidance(input.config.exposeSpawnAgentModelOverrides))
    const mode = modeAndHint(input.config, input.mode)
    if (mode) parts.push(mode)
    const dev = input.config.subagentDeveloperInstructions
    if (dev !== undefined && dev.trim() !== '') parts.push(dev)
    return parts.join('\n\n')
}

/** Assemble the root agent instructions. */
export function assembleRootPrompt(input: PromptInput): string {
    return assemble(
        input,
        appendConfiguredHint(
            BUNDLED_ROOT_ROLE,
            input.config.rootAgentUsageHintText
        ),
        -1
    )
}

/**
 * Assemble one child's instructions: bundled child clauses, the child's path
 * and parent, its role name and prompt append, and the shared policy.
 */
export function assembleChildPrompt(input: ChildPromptInput): string {
    const parts: string[] = []
    const roleIntro = [
        `Your agent path is ${input.path}. Your direct parent is ${input.parentPath ?? '/root'}.`,
        `Your assigned agent type is ${input.role.name}.`,
        input.role.promptAppend,
    ]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join('\n')
    parts.push(roleIntro)
    const bundled = appendConfiguredHint(
        BUNDLED_CHILD_ROLE,
        input.config.subagentUsageHintText
    )
    parts.push(bundled)
    parts.push(assemble(input, null, input.currentDepth ?? 0))
    return parts.join('\n\n')
}
