/**
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * codex-rs/core/src/session/multi_agents.rs (role prompt constants)
 *
 * Until the pinned Codex LICENSE/NOTICE is verified, these are original
 * behavioral equivalents preserving the required meaning clauses:
 * root/child identity, recursive spawn, tool distinctions, fork_turns,
 * envelope shape, shared filesystem/cwd, direct-tool-call requirement,
 * wait guidance, capacity count, and model-override guidance.
 */

import type { CodexSubagentsConfig } from './config.ts'
import { modeInstructions, type MultiAgentMode } from './mode.ts'

export interface PromptAssemblyInput {
    readonly config: CodexSubagentsConfig
    readonly mode: MultiAgentMode
    /** Active execution slots shared across the tree, including self. */
    readonly activeSlotCount: number
}

function configuredOrBundled(
    configured: string | undefined,
    bundled: string
): string | null {
    if (configured !== undefined) {
        // Explicitly configured empty string suppresses fallback.
        if (configured.trim() === '') return null
        return configured
    }
    return bundled
}

const BUNDLED_ROOT_ROLE = [
    'You are /root, the primary agent in a team of agents with equivalent capability.',
    'You can create subagents with the collaboration.spawn_agent tool; they may recursively spawn their own children.',
    'Use spawn_agent to create an agent for one bounded task, followup_task to trigger additional work on an existing agent, and send_message to communicate without triggering a turn.',
    'fork_turns chooses propagated conversation history: all (default), none, or the most recent N turns.',
    'Incoming child communication arrives as typed envelopes with Message Type (NEW_TASK, MESSAGE, FINAL_ANSWER), Task name, Sender, and Payload.',
    'Call collaboration tools directly; never ask another agent to call them on your behalf.',
].join(' ')

const BUNDLED_CHILD_ROLE = [
    'You are one agent in a team rooted at /root. You may recursively spawn children with the same collaboration tools where supported.',
    'Distinguish NEW_TASK (trigger additional work), MESSAGE (queue-only communication), and FINAL_ANSWER (terminal result to your direct parent).',
    'Your final-channel response is delivered to your direct parent as a bounded FINAL_ANSWER; keep it self-contained.',
    'Call collaboration tools directly; never ask another agent to call them on your behalf.',
].join(' ')

const SHARED_GUIDANCE = [
    'All agents share the same filesystem and working directory; edits are immediately visible to every agent.',
    'Coordinate through explicit messages and stable task paths; do not duplicate work another agent already owns.',
].join(' ')

function waitGuidance(enabled: boolean): string | null {
    if (!enabled) return null
    return 'When waiting for other agents, prefer one long wait_agent call over busy polling with short waits.'
}

function overridesGuidance(exposed: boolean): string | null {
    if (!exposed) {
        return 'Children inherit the parent model and reasoning effort; explicit model or reasoning overrides are unavailable.'
    }
    return 'Model and reasoning overrides are independent of fork_turns and should be used only when explicitly requested or instructed.'
}

/** Root role hint with configured-override precedence. */
export function rootRoleInstructions(
    config: CodexSubagentsConfig
): string | null {
    return configuredOrBundled(config.rootAgentUsageHintText, BUNDLED_ROOT_ROLE)
}

/** Child role hint with configured-override precedence. */
export function subagentRoleInstructions(
    config: CodexSubagentsConfig
): string | null {
    return configuredOrBundled(config.subagentUsageHintText, BUNDLED_CHILD_ROLE)
}

/** Assemble the full developer context for the root agent. */
export function assembleRootPrompt(input: PromptAssemblyInput): string {
    const parts: string[] = []
    const role = rootRoleInstructions(input.config)
    if (role) parts.push(role)
    parts.push(SHARED_GUIDANCE)
    const wait = waitGuidance(input.config.waitAgentEnabled)
    if (wait) parts.push(wait)
    parts.push(
        `Active agent concurrency: ${input.activeSlotCount} slot(s) available including this agent.`
    )
    const overrides = overridesGuidance(
        input.config.exposeSpawnAgentModelOverrides
    )
    if (overrides) parts.push(overrides)
    const customMode = input.config.multiAgentModeHintText
    const mode =
        customMode !== undefined
            ? customMode.trim() === ''
                ? null
                : customMode
            : modeInstructions(input.mode)
    if (mode) parts.push(mode)
    const dev = input.config.subagentDeveloperInstructions
    if (dev !== undefined && dev.trim() !== '') parts.push(dev)
    return parts.join('\n\n')
}

/** Assemble the developer context for a child agent. */
export function assembleChildPrompt(input: PromptAssemblyInput): string {
    const parts: string[] = []
    const role = subagentRoleInstructions(input.config)
    if (role) parts.push(role)
    parts.push(SHARED_GUIDANCE)
    const wait = waitGuidance(input.config.waitAgentEnabled)
    if (wait) parts.push(wait)
    parts.push(
        `Active agent concurrency: ${input.activeSlotCount} slot(s) available including this agent.`
    )
    const dev = input.config.subagentDeveloperInstructions
    if (dev !== undefined && dev.trim() !== '') parts.push(dev)
    return parts.join('\n\n')
}
