/**
 * Source provenance for the Codex MultiAgentV2 behavioral port.
 *
 * Behavioral port of:
 * openai/codex@9d83c48e5c4761c4fe29995305914021dcfbe7cd
 * feature: MultiAgentV2
 *
 * Keep observable behavior aligned with the upstream implementation.
 * No upstream source text is copied here; prompts are original
 * behavioral equivalents until the pinned LICENSE/NOTICE is verified.
 */

export const CODEX_SOURCE_BASELINE = {
    repository: 'openai/codex',
    revision: '9d83c48e5c4761c4fe29995305914021dcfbe7cd',
    feature: 'MultiAgentV2',
} as const

export const PI_BASELINE_NOTE =
    'Concrete Pi symbols are bound in docs/PI_API_BINDINGS.md against the installed @earendil-works/pi-coding-agent.'

export const EFFECT_BASELINE = {
    package: 'effect',
    version: '4.0.0-beta.98',
} as const
