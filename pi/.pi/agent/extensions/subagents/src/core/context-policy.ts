/**
 * Pure spawn-context resolution.
 *
 * Precedence: an explicit fork_turns request, then the role context policy,
 * then the default full fork. No coordinator state is involved; the returned
 * source explains which layer decided.
 */

import type { RoleContextPolicy } from '../config/roles.ts'
import { parseForkTurns, type ForkTurns } from '../domain/communication.ts'

export interface ResolvedSpawnContext {
    readonly fork: ForkTurns
    readonly source: 'request' | 'role' | 'default'
}

/**
 * Resolve the fork for one spawn.
 *
 * `requested` is parsed exactly like the coordinator's fork_turns argument.
 * An explicit request wins even when it is invalid: parsing throws instead of
 * falling back to the role policy. A configured role policy, including
 * `inherit`, reports source `role`; `default` means no request and no policy.
 */
export function resolveSpawnContext(
    requested: string | undefined,
    role: { context?: RoleContextPolicy } | undefined
): ResolvedSpawnContext {
    if (requested !== undefined) {
        return { fork: parseForkTurns(requested), source: 'request' }
    }
    const policy = role?.context
    if (policy !== undefined) {
        return { fork: forkForPolicy(policy), source: 'role' }
    }
    return { fork: { _tag: 'All' }, source: 'default' }
}

function forkForPolicy(policy: RoleContextPolicy): ForkTurns {
    switch (policy.mode) {
        case 'inherit':
            return { _tag: 'All' }
        case 'none':
            return { _tag: 'None' }
        case 'lastN':
            if (!Number.isSafeInteger(policy.turns) || policy.turns < 1) {
                throw new Error(
                    `Invalid role context lastN turns "${String(policy.turns)}": use a positive integer.`
                )
            }
            return { _tag: 'LastN', turns: policy.turns }
        default: {
            const mode = (policy as { mode?: unknown }).mode
            throw new Error(
                `Invalid role context mode "${String(mode)}": use "inherit", "none", or "lastN".`
            )
        }
    }
}
