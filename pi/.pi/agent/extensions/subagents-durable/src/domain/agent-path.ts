/**
 * Canonical task-path policy.
 *
 * Paths are `/root`, `/root/a`, `/root/a/b`. A `task_name` is one narrow
 * segment: lowercase letters, digits, and underscore only.
 */

/** Canonical agent path rooted at `/root`. */
export type AgentPath = string

export const ROOT_PATH: AgentPath = '/root'

const SEGMENT_RE = /^[a-z0-9_]+$/

/** True when the value is a syntactically valid canonical agent path. */
export function isValidAgentPath(value: string): value is AgentPath {
    if (value !== ROOT_PATH && !value.startsWith(`${ROOT_PATH}/`)) return false
    if (value === ROOT_PATH) return true
    const rest = value.slice(`${ROOT_PATH}/`.length)
    if (rest.length === 0) return false
    const segments = rest.split('/')
    if (segments.some((segment) => segment.length === 0)) return false
    return segments.every((segment) => SEGMENT_RE.test(segment))
}

/** True when the value is a valid single `task_name` segment. */
export function isValidTaskName(value: string): boolean {
    return value.length > 0 && SEGMENT_RE.test(value)
}

/** Parse and normalize a canonical path, throwing on invalid input. */
export function parseAgentPath(value: string): AgentPath {
    if (!isValidAgentPath(value)) throw new InvalidAgentTargetError(value)
    return value
}

/** Join a parent path with one `task_name` segment. */
export function joinAgentPath(parent: AgentPath, taskName: string): AgentPath {
    if (!isValidTaskName(taskName)) throw new InvalidTaskNameError(taskName)
    return parseAgentPath(`${parent}/${taskName}`)
}

/** Parent of a canonical path, or null for `/root`. */
export function parentAgentPath(path: AgentPath): AgentPath | null {
    if (path === ROOT_PATH) return null
    const index = path.lastIndexOf('/')
    if (index <= 0) return null
    const parent = path.slice(0, index)
    return parent === ROOT_PATH ? ROOT_PATH : parseAgentPath(parent)
}

/** True for the canonical root. */
export function isRootPath(path: AgentPath): boolean {
    return path === ROOT_PATH
}

/**
 * Nesting depth below the root: a direct child of `/root` has depth 0, its
 * child depth 1, and so on. `/root` itself is -1.
 */
export function childDepth(path: AgentPath): number {
    return path.split('/').filter(Boolean).length - 2
}

/**
 * Resolve a tool target relative to the caller.
 * - Absolute targets must be canonical (`/root/...`).
 * - Bare names resolve as siblings (`parent + name`).
 * - `./child` resolves under the caller.
 * - `../sibling` resolves as a child of the caller's parent.
 * - `a/b` resolves as a path under the caller.
 */
export function resolveTarget(from: AgentPath, target: string): AgentPath {
    const trimmed = target.trim()
    if (trimmed.length === 0) throw new InvalidAgentTargetError(target)
    if (trimmed.startsWith('/')) return parseAgentPath(trimmed)
    if (trimmed.startsWith('./')) {
        const rest = trimmed.slice(2)
        if (!rest || rest.includes('/')) {
            // Only single-segment `./child` is supported; deeper relative
            // paths must be spelled out to avoid ambiguous traversal.
            throw new InvalidAgentTargetError(target)
        }
        return joinAgentPath(from, rest)
    }
    if (trimmed.startsWith('../')) {
        const rest = trimmed.slice(3)
        if (!rest || rest.includes('/') || !isValidTaskName(rest)) {
            throw new InvalidAgentTargetError(target)
        }
        const parent = parentAgentPath(from)
        if (parent === null) throw new InvalidAgentTargetError(target)
        return joinAgentPath(parent, rest)
    }
    if (!trimmed.includes('/')) {
        // Bare name: sibling under the caller's parent, or child of /root.
        const parent = parentAgentPath(from)
        if (parent === null) return joinAgentPath(from, trimmed)
        return joinAgentPath(parent, trimmed)
    }
    // Multi-segment relative path resolves under the caller.
    let current = from
    for (const segment of trimmed.split('/')) {
        if (segment === '.' || segment === '') continue
        if (segment === '..') {
            const parent = parentAgentPath(current)
            if (parent === null) throw new InvalidAgentTargetError(target)
            current = parent
            continue
        }
        current = joinAgentPath(current, segment)
    }
    return current
}

/**
 * Segment-aware prefix check for `list_agents` filtering. `/root/a` matches
 * `/root/a` and `/root/a/b` but not `/root/ab`.
 */
export function pathMatchesPrefix(path: AgentPath, prefix: string): boolean {
    if (!prefix) return true
    const normalized =
        prefix.endsWith('/') && prefix !== '/' ? prefix.slice(0, -1) : prefix
    if (path === normalized) return true
    return path.startsWith(`${normalized}/`)
}

export class InvalidTaskNameError extends Error {
    readonly _tag = 'InvalidTaskName'
    readonly taskName: string

    constructor(taskName: string) {
        super(
            `Invalid task_name "${taskName}": use lowercase letters, digits, and underscore only.`
        )
        this.name = 'InvalidTaskNameError'
        this.taskName = taskName
    }
}

export class InvalidAgentTargetError extends Error {
    readonly _tag = 'InvalidAgentTarget'
    readonly target: string

    constructor(target: string) {
        super(
            `Invalid agent target "${target}": use a canonical /root/... path or a relative task name.`
        )
        this.name = 'InvalidAgentTargetError'
        this.target = target
    }
}
