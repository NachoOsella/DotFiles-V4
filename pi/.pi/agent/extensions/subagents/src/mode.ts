/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/core/src/context/multi_agent_mode_instructions.rs
 * codex-rs/core/src/session/multi_agents.rs (mode resolution)
 *
 * Original wording (behavioral equivalent, not upstream copy):
 * explicit-only is the safe default; proactive applies only with a
 * verified high-reasoning equivalent or an explicit custom hint.
 */

export type MultiAgentMode =
    | { readonly _tag: 'ExplicitRequestOnly' }
    | { readonly _tag: 'Proactive' }
    | { readonly _tag: 'Custom'; readonly hint: string }

import type { CodexSubagentsConfig } from './config.ts'

export interface ModeResolutionInput {
    /** True when the host exposes a verified Ultra/high-reasoning equivalent. */
    readonly ultraReasoning: boolean
    /** Custom hint override; empty string suppresses the mode fragment. */
    readonly customModeHint?: string
}

export function resolveMode(input: ModeResolutionInput): MultiAgentMode {
    if (input.customModeHint !== undefined) {
        return { _tag: 'Custom', hint: input.customModeHint }
    }
    if (input.ultraReasoning) return { _tag: 'Proactive' }
    return { _tag: 'ExplicitRequestOnly' }
}

/** Resolve the configured mode against the caller's current thinking level. */
export function resolveConfiguredMode(
    config: CodexSubagentsConfig,
    thinkingLevel: string
): MultiAgentMode {
    if (config.multiAgentModeHintText !== undefined) {
        return resolveMode({
            ultraReasoning: false,
            customModeHint: config.multiAgentModeHintText,
        })
    }
    if (config.mode === 'explicit') return { _tag: 'ExplicitRequestOnly' }
    if (config.mode === 'proactive') return { _tag: 'Proactive' }
    return resolveMode({
        ultraReasoning:
            thinkingLevel === config.proactiveAt ||
            (config.proactiveAt === 'max' && thinkingLevel === 'max'),
    })
}

/** Developer fragment for the resolved mode (null when suppressed). */
export function modeInstructions(mode: MultiAgentMode): string | null {
    switch (mode._tag) {
        case 'ExplicitRequestOnly':
            return [
                'Multi-agent delegation is explicit-only.',
                'Delegate to a subagent only when the user explicitly asks, or when',
                'repository or skill instructions explicitly authorize delegation.',
                'Any earlier proactive delegation guidance is revoked.',
            ].join(' ')
        case 'Proactive':
            return [
                'You may delegate proactively when parallel subagent work saves',
                'meaningful time or improves quality. Prefer one bounded task per',
                'agent and avoid duplicating work already assigned.',
            ].join(' ')
        case 'Custom':
            if (mode.hint.trim() === '') return null
            return mode.hint
    }
}
