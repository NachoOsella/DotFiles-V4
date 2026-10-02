/**
 * Optional native coding tools for the Durable host.
 *
 * The tools come from `@earendil-works/pi-durable/tools`; they reach files and
 * processes only through the call's execution environment. There is no
 * AgentSession and no per-child workspace snapshot. The host decides whether to
 * install this extension and supplies the environment.
 */

import type { Context } from '@earendil-works/chord'
import type {
    EnvTarget,
    Extension,
    ToolRegistration,
} from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'

export interface NodeEnvironmentOptions {
    /** Fallback directory when a conversation has no `cwd`. Default: process.cwd(). */
    readonly cwd?: string
    readonly shellPath?: string
    readonly shellEnv?: NodeJS.ProcessEnv
}

/** The `read`, `write`, `edit`, and `bash` extension (`coding-tools`). */
export function createCodingToolsExtension(): Extension<ToolRegistration> {
    return CodingTools
}

/**
 * Build one `HarnessOptions.env` function that returns a local Node environment
 * per use. A fresh object per call is fine; Durable serializes `edit` and
 * `write` per file by the environment's `id` and path.
 */
export function createNodeEnvironment(
    options: NodeEnvironmentOptions = {}
): (
    target: EnvTarget,
    context: Context
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined> {
    return ({ cwd }) =>
        new NodeExecutionEnv({
            cwd: cwd ?? options.cwd ?? process.cwd(),
            ...(options.shellPath === undefined
                ? {}
                : { shellPath: options.shellPath }),
            ...(options.shellEnv === undefined
                ? {}
                : { shellEnv: options.shellEnv }),
        })
}
