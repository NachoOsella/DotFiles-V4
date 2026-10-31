/**
 * Snapshot persistence for goals.
 *
 * Every transition appends one `custom` session entry (`customType:
 * "goal-snapshot"`) holding the complete snapshot. The read path scans a
 * session branch newest-first and takes the first entry that validates against
 * `GoalSnapshotSchema`; unusable entries are skipped with a recorded issue, so a
 * corrupt write can never brick a session.
 */
import { Effect, Schema } from "effect";
import { GoalPersistenceError } from "../domain/errors.ts";
import {
    GOAL_CLEARED_CUSTOM_TYPE,
    GOAL_SNAPSHOT_CUSTOM_TYPE,
    GOAL_SNAPSHOT_VERSION,
    GoalSnapshotSchema,
    type GoalLoadIssue,
    type GoalLoadResult,
    type GoalSnapshot,
    type TranscriptEntry,
} from "../domain/goal.ts";

/** Issues kept when newer invalid entries shadow the snapshot that loads. */
const MAX_LOAD_ISSUES = 3;

const decodeSnapshot = Schema.decodeUnknownResult(GoalSnapshotSchema);

/** True when the entry is a persisted goal snapshot. */
export function isSnapshotEntry(entry: TranscriptEntry): boolean {
    return (
        entry.type === "custom" &&
        entry.customType === GOAL_SNAPSHOT_CUSTOM_TYPE
    );
}

/** True when the entry is a cleared-goal tombstone. */
export function isClearedEntry(entry: TranscriptEntry): boolean {
    return entry.type === "custom" && entry.customType === GOAL_CLEARED_CUSTOM_TYPE;
}

/**
 * Decode one entry's `data` into a snapshot. Never throws: string payloads are
 * parsed as JSON first, and anything unusable becomes a load issue. The optional
 * `entryId` is copied into the issue; `loadLatestSnapshot` supplies it.
 */
export function parseSnapshot(
    data: unknown,
    entryId = "",
): { ok: true; snapshot: GoalSnapshot } | { ok: false; issue: GoalLoadIssue } {
    let value: unknown = data;
    if (typeof data === "string") {
        try {
            value = JSON.parse(data);
        } catch (error) {
            return {
                ok: false,
                issue: {
                    kind: "corrupt",
                    entryId,
                    message: `Snapshot is not valid JSON: ${describeError(error)}`,
                },
            };
        }
    }

    const decoded = decodeSnapshot(value);
    if (decoded._tag === "Success") {
        return { ok: true, snapshot: decoded.success };
    }

    const version = readVersion(value);
    if (version !== null && version !== GOAL_SNAPSHOT_VERSION) {
        return {
            ok: false,
            issue: { kind: "unsupported-version", entryId, version },
        };
    }

    return {
        ok: false,
        issue: { kind: "corrupt", entryId, message: decoded.failure.message },
    };
}

/**
 * Load the authoritative snapshot for a branch.
 *
 * Scans backwards and returns the newest entry that parses, plus up to three
 * issues from the newer entries that were skipped. Without a valid entry the
 * result is `snapshot: null` with whatever issues the scan collected.
 */
export function loadLatestSnapshot(
    branch: readonly TranscriptEntry[],
): GoalLoadResult {
    const issues: GoalLoadIssue[] = [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (isClearedEntry(entry)) {
            return { snapshot: null, issues, entryId: entry.id, cleared: true };
        }
        if (!isSnapshotEntry(entry)) continue;
        const parsed = parseSnapshot(entry.data, entry.id);
        if (parsed.ok) {
            return {
                snapshot: parsed.snapshot,
                issues,
                entryId: entry.id,
                cleared: false,
            };
        }
        if (issues.length < MAX_LOAD_ISSUES) issues.push(parsed.issue);
    }
    return { snapshot: null, issues, entryId: null, cleared: false };
}

/** Append a tombstone so a cleared goal stays cleared across restarts. */
export function persistCleared(
    appendEntry: (customType: string, data: unknown) => void,
    goalId: string,
    at: number,
): Effect.Effect<void, GoalPersistenceError> {
    return Effect.try({
        try: () => {
            appendEntry(GOAL_CLEARED_CUSTOM_TYPE, { goalId, at, version: GOAL_SNAPSHOT_VERSION });
        },
        catch: (error) =>
            new GoalPersistenceError({
                message: "Failed to persist goal removal",
                detail: describeError(error),
            }),
    });
}

/**
 * Append one snapshot through a writer supplied by the host.
 *
 * The writer is `pi.appendEntry` in production and the fake session in tests, so
 * writes always land on the same branch the engine reads. Thrown errors become
 * `GoalPersistenceError` instead of defects.
 */
export function persistSnapshot(
    appendEntry: (customType: string, data: unknown) => void,
    snapshot: GoalSnapshot,
): Effect.Effect<void, GoalPersistenceError> {
    return Effect.try({
        try: () => {
            appendEntry(GOAL_SNAPSHOT_CUSTOM_TYPE, snapshot);
        },
        catch: (error) =>
            new GoalPersistenceError({
                message: "Failed to persist goal snapshot",
                detail: describeError(error),
            }),
    });
}

/** Declared `version` of a raw payload, or null when absent or non-numeric. */
function readVersion(value: unknown): number | null {
    if (typeof value !== "object" || value === null) return null;
    if (!("version" in value)) return null;
    return typeof value.version === "number" ? value.version : null;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
