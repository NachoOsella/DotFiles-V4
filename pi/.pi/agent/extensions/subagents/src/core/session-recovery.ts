/**
 * Cold-reopen ownership validation.
 *
 * Pure checks only: no filesystem access and no session construction. The
 * factory resolves the facts, calls these functions, and turns a failed check
 * into AgentBlockedError so recovery never falls back to another file, role,
 * model, or silently created session.
 */

import { basename, dirname, resolve } from 'node:path'

/** Ownership metadata persisted in the child session by SessionFactory.create. */
export interface SessionOwnershipMeta {
    readonly rootSessionId?: string
    readonly path?: string
    readonly parentPath?: string | null
    readonly role?: string
}

export interface CheckResult {
    readonly ok: boolean
    readonly reason?: string
    readonly guidance?: string
}

export interface SessionFileCheck extends CheckResult {
    readonly ok: boolean
    /** Absolute path that passed the checks, present only when ok. */
    readonly sessionFile?: string
    /** Directory that must contain the session file, when known. */
    readonly expectedDir?: string
}

export interface SessionFileInput {
    readonly sessionFile?: string
    readonly rootSessionDir: string
    readonly rootSessionId: string
    /** Persisted record session id; absent on legacy records. */
    readonly expectedSessionId?: string
}

export interface OpenedSessionFacts {
    readonly sessionFile: string
    readonly expectedRootSessionId: string
    readonly expectedRecordRootSessionId?: string
    readonly expectedSessionId?: string
    readonly expectedAgentPath: string
    readonly expectedParentPath: string | null
    readonly expectedRole?: string
    readonly actualSessionId: string
    readonly headerId: string | null
    readonly meta: SessionOwnershipMeta | null
}

const RESTORE_FILE_GUIDANCE =
    'Restore the matching session file or start a new agent; no replacement session is created.'
const RESTORE_OWNERSHIP_GUIDANCE =
    'Open the session in its original root or start a new agent; no fallback team is used.'

/** Expected directory for one root tree: <rootSessionDir>/.subagents/<rootSessionId>. */
export function expectedSessionDirectory(
    rootSessionDir: string,
    rootSessionId: string
): string {
    return resolve(rootSessionDir, '.subagents', rootSessionId)
}

/** True when a value can be one path segment without traversal. */
export function isSafePathSegment(value: string): boolean {
    return (
        value.length > 0 &&
        value !== '.' &&
        value !== '..' &&
        !value.includes('/') &&
        !value.includes('\\')
    )
}

function fail(reason: string, guidance: string): CheckResult {
    return { ok: false, reason, guidance }
}

function normalizeRole(role: string | undefined): string {
    return role?.trim() || 'default'
}

function fileMatchesSession(fileName: string, sessionId: string): boolean {
    return (
        fileName === `${sessionId}.jsonl` ||
        fileName.endsWith(`_${sessionId}.jsonl`)
    )
}

/**
 * Validate the recorded session path before opening it.
 *
 * Rejects an unset path, an unset session directory, unsafe ids, a file that
 * is not directly inside the expected tree directory, a non-JSONL file, and a
 * basename that does not carry the recorded session id.
 */
export function checkSessionFile(input: SessionFileInput): SessionFileCheck {
    if (!input.rootSessionDir) {
        return {
            ok: false,
            reason: 'no persistent session directory is configured',
            guidance:
                'Sessions created in memory cannot be reopened; start a new agent.',
        }
    }
    if (!input.sessionFile) {
        return {
            ok: false,
            reason: 'the agent record has no persisted session file',
            guidance:
                'Spawn a fresh agent or restore a snapshot that includes sessionFile; no session is created.',
        }
    }
    if (!isSafePathSegment(input.rootSessionId)) {
        return {
            ok: false,
            reason: `root session id "${input.rootSessionId}" is not a valid path segment`,
            guidance: RESTORE_FILE_GUIDANCE,
        }
    }
    if (
        input.expectedSessionId !== undefined &&
        !isSafePathSegment(input.expectedSessionId)
    ) {
        return {
            ok: false,
            reason: `recorded session id "${input.expectedSessionId}" is not a valid path segment`,
            guidance: RESTORE_FILE_GUIDANCE,
        }
    }
    const expectedDir = expectedSessionDirectory(
        input.rootSessionDir,
        input.rootSessionId
    )
    const sessionFile = resolve(input.sessionFile)
    if (dirname(sessionFile) !== expectedDir) {
        return {
            ok: false,
            expectedDir,
            reason: `the session file is outside ${expectedDir}`,
            guidance: RESTORE_FILE_GUIDANCE,
        }
    }
    const fileName = basename(sessionFile)
    if (!fileName.endsWith('.jsonl') || fileName === '.jsonl') {
        return {
            ok: false,
            expectedDir,
            reason: 'the session file is not a JSONL session',
            guidance: RESTORE_FILE_GUIDANCE,
        }
    }
    if (
        input.expectedSessionId !== undefined &&
        !fileMatchesSession(fileName, input.expectedSessionId)
    ) {
        return {
            ok: false,
            expectedDir,
            reason: `the session file name does not match recorded session "${input.expectedSessionId}"`,
            guidance: RESTORE_FILE_GUIDANCE,
        }
    }
    return { ok: true, sessionFile, expectedDir }
}

/**
 * Validate the opened session against the record and the current root.
 *
 * The header id is authoritative. The file name must carry that id, the
 * persisted ownership entry must name the current root and this agent path,
 * and a recorded session id must match exactly.
 */
export function checkOpenedSession(facts: OpenedSessionFacts): CheckResult {
    if (facts.headerId === null) {
        return fail(
            'the session file has no session header',
            RESTORE_FILE_GUIDANCE
        )
    }
    if (facts.headerId !== facts.actualSessionId) {
        return fail(
            `the session header id "${facts.headerId}" does not match the opened session "${facts.actualSessionId}"`,
            RESTORE_FILE_GUIDANCE
        )
    }
    if (
        facts.expectedSessionId !== undefined &&
        facts.actualSessionId !== facts.expectedSessionId
    ) {
        return fail(
            `the opened session "${facts.actualSessionId}" does not match recorded session "${facts.expectedSessionId}"`,
            RESTORE_FILE_GUIDANCE
        )
    }
    const fileName = basename(facts.sessionFile)
    if (!fileMatchesSession(fileName, facts.actualSessionId)) {
        return fail(
            `the session file name does not match its session id "${facts.actualSessionId}"`,
            RESTORE_FILE_GUIDANCE
        )
    }
    if (facts.meta === null) {
        return fail(
            'the session has no subagent ownership metadata',
            RESTORE_OWNERSHIP_GUIDANCE
        )
    }
    if (
        facts.expectedRecordRootSessionId !== undefined &&
        facts.expectedRecordRootSessionId !== facts.expectedRootSessionId
    ) {
        return fail(
            `the record belongs to root "${facts.expectedRecordRootSessionId}", not "${facts.expectedRootSessionId}"`,
            RESTORE_OWNERSHIP_GUIDANCE
        )
    }
    if (facts.meta.rootSessionId !== facts.expectedRootSessionId) {
        return fail(
            `the session belongs to root "${facts.meta.rootSessionId ?? 'unknown'}", not "${facts.expectedRootSessionId}"`,
            RESTORE_OWNERSHIP_GUIDANCE
        )
    }
    if (facts.meta.path !== facts.expectedAgentPath) {
        return fail(
            `the session belongs to agent "${facts.meta.path ?? 'unknown'}", not "${facts.expectedAgentPath}"`,
            RESTORE_OWNERSHIP_GUIDANCE
        )
    }
    const metaRole = normalizeRole(facts.meta.role)
    const expectedRole = normalizeRole(facts.expectedRole)
    if (metaRole !== expectedRole) {
        return fail(
            `the session was created with agent_type "${metaRole}", not "${expectedRole}"`,
            'Restore the matching role or start a new agent; the role is not changed on reopen.'
        )
    }
    if ((facts.meta.parentPath ?? null) !== facts.expectedParentPath) {
        return fail(
            `the session parent "${facts.meta.parentPath ?? 'none'}" does not match "${facts.expectedParentPath ?? 'none'}"`,
            RESTORE_OWNERSHIP_GUIDANCE
        )
    }
    return { ok: true }
}
