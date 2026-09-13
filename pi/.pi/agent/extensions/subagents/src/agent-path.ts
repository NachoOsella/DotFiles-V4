/**
 * Behavioral port of:
 * openai/codex@a592c38c16cdd7623dacc9168926ebccedfb67d3
 * codex-rs/core/src/agent/agent_resolver.rs
 *
 * Canonical task paths: /root, /root/a, /root/a/b.
 * task_name is a single narrow segment: lowercase letters, digits, underscore.
 */

import type { AgentPath } from './ids.ts'

export const ROOT_PATH = '/root' as AgentPath

const SEGMENT_RE = /^[a-z0-9_]+$/

/** True when the value is a syntactically valid canonical agent path. */
export function isValidAgentPath(value: string): value is AgentPath {
    if (value !== '/root' && !value.startsWith('/root/')) return false
    if (value === '/root') return true
    const rest = value.slice('/root/'.length)
    if (rest.length === 0) return false
    const segments = rest.split('/')
    if (segments.some((s) => s.length === 0)) return false
    return segments.every((s) => SEGMENT_RE.test(s))
}

/** True when the value is a valid single task_name segment. */
export function isValidTaskName(value: string): boolean {
    return value.length > 0 && SEGMENT_RE.test(value)
}

/** Parse and normalize a canonical path, throwing on invalid input. */
export function parseAgentPath(value: string): AgentPath {
    if (!isValidAgentPath(value)) {
        throw new InvalidAgentTargetError(value)
    }
    return value as AgentPath
}

/** Join a parent path with one task_name segment. */
export function joinAgentPath(parent: AgentPath, taskName: string): AgentPath {
    if (!isValidTaskName(taskName)) {
        throw new InvalidTaskNameError(taskName)
    }
    const child = `${parent}/${taskName}`
    return parseAgentPath(child)
}

/** Parent of a canonical path, or null for /root. */
export function parentAgentPath(path: AgentPath): AgentPath | null {
    if (path === ('/root' as AgentPath)) return null
    const idx = path.lastIndexOf('/')
    if (idx <= 0) return null
    const parent = path.slice(0, idx)
    if (parent === '/root') return ROOT_PATH
    return parseAgentPath(parent)
}

/** True for the canonical root. */
export function isRootPath(path: AgentPath): boolean {
    return path === ('/root' as AgentPath)
}

/**
 * Resolve a tool target relative to the caller.
 * - Absolute targets must be canonical (/root/...).
 * - Bare names resolve as siblings (parent + name), matching Codex
 *   relative target behavior for the common single-segment case.
 * - "child/grandchild" resolves under the caller.
 * - "./x" and "../sibling" forms are supported explicitly.
 */
export function resolveTarget(from: AgentPath, target: string): AgentPath {
    const trimmed = target.trim()
    if (trimmed.length === 0) throw new InvalidAgentTargetError(target)
    if (trimmed.startsWith('/')) return parseAgentPath(trimmed)
    if (trimmed.startsWith('./')) {
        const rest = trimmed.slice(2)
        if (!rest || rest.includes('/')) {
            // Only single-segment ./child is supported; deeper paths must be
            // spelled out to avoid ambiguous traversal semantics.
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
        const grandparent = parentAgentPath(parent)
        // Sibling of caller = child of caller's parent.
        void grandparent
        return joinAgentPath(parent, rest)
    }
    if (!trimmed.includes('/')) {
        // Bare name: sibling under the caller's parent, or child of root.
        if (isRootPath(from)) return joinAgentPath(from, trimmed)
        const parent = parentAgentPath(from)
        if (parent === null) throw new InvalidAgentTargetError(target)
        return joinAgentPath(parent, trimmed)
    }
    // Multi-segment relative path resolves under the caller.
    const segments = trimmed.split('/')
    let current = from
    for (const segment of segments) {
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
 * Segment-aware prefix check for list_agents path_prefix filtering.
 * "/root/a" matches "/root/a" and "/root/a/b" but not "/root/ab".
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
