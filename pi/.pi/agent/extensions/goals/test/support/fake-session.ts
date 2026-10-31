/**
 * In-memory model of the parts of a Pi session the goal engine depends on.
 *
 * It mirrors Pi 1.4.0 `SessionManager` behaviour that matters for goals:
 * append-only entries with parent links, a movable leaf (`/tree`), branch
 * copies (`/fork`, `/clone`), usage entries, and compaction-aware context
 * projection. Ids are `e1`, `e2`, ... and timestamps come from a deterministic
 * clock, so tests never depend on `Date.now()` or real timers.
 *
 * Only the structural subset the domain reads is modelled. The class does not
 * persist to disk; the session file and line-per-entry durability are out of
 * scope.
 */
import type { TranscriptEntry, TranscriptMessage, UsageSnapshot } from "../../src/domain/goal.ts";

/** Fixed starting point of the fake clock: 2023-11-14T22:13:20.000Z. */
export const FAKE_EPOCH_MS = 1_700_000_000_000;

export interface FakeTextContent {
    readonly type: "text";
    readonly text: string;
}

export interface FakeToolCallContent {
    readonly type: "toolCall";
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
}

export type FakeAssistantContent = FakeTextContent | FakeToolCallContent;

export interface FakeUserMessage extends TranscriptMessage {
    readonly role: "user";
    readonly content: string;
    readonly timestamp: number;
}

export interface FakeAssistantMessage extends TranscriptMessage {
    readonly role: "assistant";
    readonly content: readonly FakeAssistantContent[];
    readonly usage: UsageSnapshot;
    readonly stopReason: string;
    readonly errorMessage?: string;
    readonly timestamp: number;
}

export interface FakeToolResultMessage extends TranscriptMessage {
    readonly role: "toolResult";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: readonly FakeTextContent[];
    readonly isError: boolean;
    readonly usage?: UsageSnapshot;
    readonly timestamp: number;
}

export type FakeMessage = FakeUserMessage | FakeAssistantMessage | FakeToolResultMessage;

/**
 * One session entry. Mirrors Pi's `SessionEntry`: every entry has an id, a
 * parent id (null for a root), an ISO timestamp, and is appended as a child of
 * the current leaf.
 */
export interface FakeEntry extends TranscriptEntry {
    readonly parentId: string | null;
    readonly timestamp: string;
    readonly message?: FakeMessage;
}

export interface FakeMessageEntry extends FakeEntry {
    readonly type: "message";
    readonly message: FakeMessage;
}

export interface FakeCustomEntry extends FakeEntry {
    readonly type: "custom";
    readonly customType: string;
    readonly data: unknown;
}

export interface FakeCustomMessageEntry extends FakeEntry {
    readonly type: "custom_message";
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
}

export interface FakeUsageEntry extends FakeEntry {
    readonly type: "usage";
    readonly kind: string;
    readonly provider: string;
    readonly model: string;
    readonly usage: UsageSnapshot;
}

export interface FakeCompactionEntry extends FakeEntry {
    readonly type: "compaction";
    readonly summary: string;
    readonly firstKeptEntryId: string;
    readonly tokensBefore: number;
}

export function isAssistantMessageEntry(
    entry: FakeEntry,
): entry is FakeMessageEntry & { readonly message: FakeAssistantMessage } {
    return entry.type === "message" && entry.message?.role === "assistant";
}

export function isCustomEntry(entry: FakeEntry): entry is FakeCustomEntry {
    return entry.type === "custom";
}

export function isCustomMessageEntry(entry: FakeEntry): entry is FakeCustomMessageEntry {
    return entry.type === "custom_message";
}

export function isUsageEntry(entry: FakeEntry): entry is FakeUsageEntry {
    return entry.type === "usage";
}

export function isCompactionEntry(entry: FakeEntry): entry is FakeCompactionEntry {
    return entry.type === "compaction" && "firstKeptEntryId" in entry && "summary" in entry;
}

/** Newest assistant message entry on a branch, or null when there is none. */
export function newestAssistantEntry(branch: readonly FakeEntry[]): FakeMessageEntry | null {
    for (let i = branch.length - 1; i >= 0; i -= 1) {
        const entry = branch[i];
        if (entry !== undefined && isAssistantMessageEntry(entry)) return entry;
    }
    return null;
}

function normalizeUsage(partial: Partial<UsageSnapshot> | undefined): UsageSnapshot {
    const input = partial?.input ?? 0;
    const output = partial?.output ?? 0;
    const cacheRead = partial?.cacheRead ?? 0;
    const cacheWrite = partial?.cacheWrite ?? 0;
    const usage: UsageSnapshot = {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { total: partial?.cost?.total ?? 0 },
    };
    if (partial?.reasoning === undefined) return usage;
    return { ...usage, reasoning: partial.reasoning };
}

function entryTokens(entry: FakeEntry): number {
    return (entry.message?.usage?.totalTokens ?? 0) + (entry.usage?.totalTokens ?? 0);
}

export interface FakeSessionOptions {
    readonly sessionId?: string;
}

export interface FakeToolCall {
    readonly id: string;
    readonly name: string;
}

export interface FakeAssistantInput {
    readonly text?: string;
    readonly usage?: Partial<UsageSnapshot>;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly toolCalls?: readonly FakeToolCall[];
}

export interface FakeToolResultInput {
    readonly toolName: string;
    readonly isError?: boolean;
    readonly usage?: Partial<UsageSnapshot>;
}

export class FakeSession {
    readonly sessionId: string;

    #entries: FakeEntry[] = [];
    readonly #byId = new Map<string, FakeEntry>();
    #leafId: string | null = null;
    #nextId = 1;
    #clock: number;
    #lastStampMs: number;
    #forkSeq = 0;

    constructor(options: FakeSessionOptions = {}) {
        this.sessionId = options.sessionId ?? "fake-session-1";
        this.#clock = FAKE_EPOCH_MS;
        this.#lastStampMs = FAKE_EPOCH_MS;
    }

    /** Current deterministic clock in milliseconds; only `advance` moves it. */
    now(): number {
        return this.#clock;
    }

    /** Advance the deterministic clock. */
    advance(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) {
            throw new Error(`advance: expected a non-negative finite number, got ${String(ms)}`);
        }
        this.#clock += ms;
    }

    get leafId(): string | null {
        return this.#leafId;
    }

    /** Active path from root to leaf (root first), identical to Pi's `getBranch()`. */
    getBranch(): FakeEntry[] {
        const branch: FakeEntry[] = [];
        let current = this.#leafId === null ? undefined : this.#byId.get(this.#leafId);
        while (current !== undefined) {
            branch.push(current);
            current = current.parentId === null ? undefined : this.#byId.get(current.parentId);
        }
        branch.reverse();
        return branch;
    }

    /** Every entry ever appended, including entries on abandoned branches. */
    getEntries(): FakeEntry[] {
        return [...this.#entries];
    }

    getEntry(id: string): FakeEntry | undefined {
        return this.#byId.get(id);
    }

    appendCustom(customType: string, data: unknown): FakeCustomEntry {
        const base = this.#nextEntryBase();
        return this.#append<FakeCustomEntry>({ ...base, type: "custom", customType, data });
    }

    appendCustomMessage(
        customType: string,
        content: string,
        display: boolean,
        details?: unknown,
    ): FakeCustomMessageEntry {
        const base = this.#nextEntryBase();
        return this.#append<FakeCustomMessageEntry>({
            ...base,
            type: "custom_message",
            customType,
            content,
            display,
            ...(details === undefined ? {} : { details }),
        });
    }

    appendUser(text: string): FakeMessageEntry {
        const base = this.#nextEntryBase();
        const message: FakeUserMessage = {
            role: "user",
            content: text,
            timestamp: Date.parse(base.timestamp),
        };
        return this.#append<FakeMessageEntry>({ ...base, type: "message", message });
    }

    appendAssistant(input: FakeAssistantInput = {}): FakeMessageEntry {
        const toolCalls = input.toolCalls ?? [];
        const content: FakeAssistantContent[] = [];
        if (input.text !== undefined) content.push({ type: "text", text: input.text });
        for (const call of toolCalls) {
            content.push({ type: "toolCall", id: call.id, name: call.name, arguments: {} });
        }
        const base = this.#nextEntryBase();
        const message: FakeAssistantMessage = {
            role: "assistant",
            content,
            usage: normalizeUsage(input.usage),
            stopReason: input.stopReason ?? (toolCalls.length > 0 ? "toolUse" : "stop"),
            ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
            timestamp: Date.parse(base.timestamp),
        };
        return this.#append<FakeMessageEntry>({ ...base, type: "message", message });
    }

    appendToolResult(input: FakeToolResultInput): FakeMessageEntry {
        const base = this.#nextEntryBase();
        const isError = input.isError ?? false;
        const message: FakeToolResultMessage = {
            role: "toolResult",
            toolCallId: `call-${base.id}`,
            toolName: input.toolName,
            content: [{ type: "text", text: isError ? "error" : "result" }],
            isError,
            ...(input.usage === undefined ? {} : { usage: normalizeUsage(input.usage) }),
            timestamp: Date.parse(base.timestamp),
        };
        return this.#append<FakeMessageEntry>({ ...base, type: "message", message });
    }

    appendUsageEntry(kind: string, usage: Partial<UsageSnapshot>): FakeUsageEntry {
        const base = this.#nextEntryBase();
        return this.#append<FakeUsageEntry>({
            ...base,
            type: "usage",
            kind,
            provider: "fake",
            model: "fake-model",
            usage: normalizeUsage(usage),
        });
    }

    /**
     * Move the leaf, modelling `/tree`. Like Pi's `branch()`, an unknown id is an
     * error; `null` resets the leaf so the next append becomes a new root.
     * Nothing is deleted, and later appends continue from the new leaf.
     */
    rewindTo(entryId: string | null): void {
        if (entryId !== null && !this.#byId.has(entryId)) {
            throw new Error(`Entry ${entryId} not found`);
        }
        this.#leafId = entryId;
    }

    /**
     * Copy the active branch into a new session, modelling `/fork` and `/clone`.
     * Entry ids and parent links are preserved; abandoned branches are dropped.
     * The new session gets its own id, id counter, and clock.
     */
    fork(): FakeSession {
        this.#forkSeq += 1;
        const forked = new FakeSession({ sessionId: `${this.sessionId}-fork-${this.#forkSeq}` });
        forked.#entries = this.getBranch();
        forked.#byId.clear();
        for (const entry of forked.#entries) forked.#byId.set(entry.id, entry);
        forked.#leafId = forked.#entries.at(-1)?.id ?? null;
        forked.#nextId = this.#nextId;
        forked.#clock = this.#clock;
        forked.#lastStampMs = this.#lastStampMs;
        return forked;
    }

    /**
     * Append a `compaction` entry the way Pi does: it becomes the new leaf child
     * and carries the summary, `firstKeptEntryId`, and `tokensBefore`.
     *
     * Pi tolerates a `firstKeptEntryId` that is not on the branch (the projection
     * then collapses to the summary alone, risk R6.3), so this method does not
     * validate it. Passing null creates a self-retaining compaction that keeps no
     * preceding entries, matching `appendCompaction`.
     */
    compact(firstKeptEntryId: string | null): FakeCompactionEntry {
        const branch = this.getBranch();
        const tokensBefore = branch.reduce((total, entry) => total + entryTokens(entry), 0);
        const base = this.#nextEntryBase();
        return this.#append<FakeCompactionEntry>({
            ...base,
            type: "compaction",
            summary: `Summary of ${branch.length} entries before compaction (${tokensBefore} tokens).`,
            firstKeptEntryId: firstKeptEntryId ?? base.id,
            tokensBefore,
        });
    }

    /**
     * Pi's `buildContextEntries`: the newest compaction entry, the kept entries
     * from `firstKeptEntryId` onward, then everything after the compaction. Older
     * summarized entries disappear from model context but stay on the branch.
     */
    buildContextEntries(): FakeEntry[] {
        const path = this.getBranch();
        const compaction = this.#latestCompaction(path);
        if (compaction === null) return path;
        const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
        if (compactionIndex < 0) return path;
        const contextEntries: FakeEntry[] = [compaction];
        let foundFirstKept = false;
        for (let i = 0; i < compactionIndex; i += 1) {
            const entry = path[i];
            if (entry === undefined) continue;
            if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
            // Pi also drops system messages from the kept range; this harness never
            // appends system entries, so every kept entry is included here.
            if (foundFirstKept) contextEntries.push(entry);
        }
        contextEntries.push(...path.slice(compactionIndex + 1));
        return contextEntries;
    }

    /** Filter over every entry (including abandoned branches) with a type guard. */
    filterEntriesBy<T extends FakeEntry>(predicate: (entry: FakeEntry) => entry is T): T[] {
        return this.getEntries().filter(predicate);
    }

    #latestCompaction(path: readonly FakeEntry[]): FakeCompactionEntry | null {
        for (let i = path.length - 1; i >= 0; i -= 1) {
            const entry = path[i];
            if (entry !== undefined && isCompactionEntry(entry)) return entry;
        }
        return null;
    }

    #nextEntryBase(): { readonly id: string; readonly parentId: string | null; readonly timestamp: string } {
        const id = `e${this.#nextId}`;
        this.#nextId += 1;
        const stampMs = Math.max(this.#clock + 1, this.#lastStampMs + 1);
        this.#lastStampMs = stampMs;
        return { id, parentId: this.#leafId, timestamp: new Date(stampMs).toISOString() };
    }

    #append<T extends FakeEntry>(entry: T): T {
        this.#entries.push(entry);
        this.#byId.set(entry.id, entry);
        this.#leafId = entry.id;
        return entry;
    }
}
