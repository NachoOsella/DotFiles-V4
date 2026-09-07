/** Bounded context injection so todo state survives compaction. */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { Todo } from "./types.ts";
import {
  decodeStoredTodos,
  findLatestSuccessfulSnapshot,
  snapshotsEqualTodos,
} from "./validation.ts";

type ContextMessages = ContextEvent["messages"];
type ContextMessage = ContextMessages[number];

/** Custom message type identifying synthetic todo snapshots in context. */
export const SNAPSHOT_CUSTOM_TYPE = "todowrite-snapshot";

/** Maximum injected snapshot text: 8 KiB, identities always retained. */
export const MAX_SNAPSHOT_BYTES = 8 * 1024;

/** Tool name whose results carry the canonical todo snapshot. */
const TOOL_NAME = "todowrite";

/**
 * Find the latest valid successful todo snapshot on the given branch.
 * Shares the canonical scan with session restoration so both agree on state.
 */
export function findBranchSnapshot(
  branch: readonly unknown[]
): readonly Todo[] | undefined {
  return findLatestSuccessfulSnapshot(branch);
}

/** True when at least one todo still needs work. */
export function hasUnfinishedWork(todos: readonly Todo[]): boolean {
  return todos.some((todo) => todo.status !== "completed");
}

/**
 * Compare snapshots by normalized ID, status, content, and order.
 * Substring matching would collide on similar descriptions; compare structure.
 * Kept as a wrapper over the shared comparator used by validation.
 */
export function snapshotsEqual(
  left: readonly Todo[],
  right: readonly Todo[]
): boolean {
  return snapshotsEqualTodos(left, right);
}

/** Decode a retained message's todo items when it carries a snapshot. */
function retainedSnapshotItems(
  message: ContextMessage
): readonly Todo[] | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role === "toolResult") {
    if (message.toolName !== TOOL_NAME || message.isError) return undefined;
    if (!isRecord(message.details)) return undefined;
    return decodeStoredTodos(message.details.items);
  }
  if (message.role === "custom") {
    if (message.customType !== SNAPSHOT_CUSTOM_TYPE) return undefined;
    if (!isRecord(message.details) || !Array.isArray(message.details.items)) {
      return undefined;
    }
    return decodeStoredTodos(message.details.items);
  }
  return undefined;
}

/**
 * True when the retained context already shows a snapshot equivalent to the
 * current one, either as a real tool result or a previously injected message.
 */
export function retainedHasSnapshot(
  messages: readonly ContextMessage[],
  snapshot: readonly Todo[]
): boolean {
  return messages.some((message) => {
    const items = retainedSnapshotItems(message);
    return items !== undefined && snapshotsEqual(items, snapshot);
  });
}

/** Single-line marker for a todo status in snapshot text. */
function statusMarker(status: Todo["status"]): string {
  if (status === "in_progress") return ">";
  if (status === "completed") return "x";
  return " ";
}

/** Normalize display text for snapshot lines without touching stored state. */
function snapshotDisplayText(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[\r\n]+/g, " ");
}

/** Byte length of a string as UTF-8. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Render a snapshot as bounded model-visible text.
 * Every ID and status is retained; descriptions shrink first, and any
 * omission is noted explicitly instead of silently dropping identities.
 */
export function buildSnapshotText(
  todos: readonly Todo[],
  maxBytes: number = MAX_SNAPSHOT_BYTES
): string {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const header = `Active todo plan (${completed}/${todos.length} done):`;
  const lines = todos.map(
    (todo) =>
      `[${statusMarker(todo.status)}] [${snapshotDisplayText(todo.id)}] ${snapshotDisplayText(todo.content)}`
  );

  if (byteLength([header, ...lines].join("\n")) <= maxBytes) {
    return [header, ...lines].join("\n");
  }

  const omissionReserve = 64;
  const fixedBytes =
    byteLength(header) +
    lines.length * 1 +
    todos.reduce(
      (sum, todo) =>
        sum +
        byteLength(
          `[${statusMarker(todo.status)}] [${snapshotDisplayText(todo.id)}] `
        ),
      0
    ) +
    omissionReserve;
  const contentBudget = Math.max(0, maxBytes - fixedBytes);
  const perTodoBudget = Math.floor(contentBudget / Math.max(1, todos.length));

  const contents = todos.map((todo) => {
    const text = snapshotDisplayText(todo.content);
    return [...text].length > perTodoBudget
      ? [...text].slice(0, perTodoBudget).join("")
      : text;
  });
  // Multibyte content can still overflow; trim from the longest first.
  let overflow =
    byteLength(
      [
        header,
        ...todos.map(
          (todo, index) =>
            `[${statusMarker(todo.status)}] [${snapshotDisplayText(todo.id)}] ${contents[index]}`
        ),
      ].join("\n")
    ) +
    omissionReserve -
    maxBytes;
  let omittedChars = contents.reduce(
    (sum, text, index) =>
      sum +
      ([...snapshotDisplayText(todos[index]!.content)].length -
        [...text].length),
    0
  );
  while (overflow > 0) {
    let longest = -1;
    let longestLength = 0;
    for (let index = 0; index < contents.length; index += 1) {
      const length = [...contents[index]!].length;
      if (length > longestLength) {
        longestLength = length;
        longest = index;
      }
    }
    if (longest === -1 || longestLength === 0) break;
    const chars = [...contents[longest]!];
    const removed = chars.pop()!;
    contents[longest] = chars.join("");
    omittedChars += 1;
    overflow -= byteLength(removed);
  }

  const note = `[note: ${omittedChars} description characters omitted to fit the snapshot budget]`;
  return [
    header,
    ...todos.map(
      (todo, index) =>
        `[${statusMarker(todo.status)}] [${snapshotDisplayText(todo.id)}] ${contents[index]}`
    ),
    note,
  ].join("\n");
}

/** Build the synthetic non-persisted context message for a snapshot. */
export function buildSnapshotMessage(
  todos: readonly Todo[],
  text: string
): ContextMessage {
  return {
    role: "custom",
    customType: SNAPSHOT_CUSTOM_TYPE,
    content: text,
    display: false,
    details: { tool: TOOL_NAME, items: todos.map((todo) => ({ ...todo })) },
    timestamp: Date.now(),
  } as unknown as ContextMessage;
}

/**
 * Append one synthetic snapshot message when the current plan is unfinished
 * and no equivalent snapshot is visible in the retained context.
 * Returns undefined when no injection is needed. Never reorders, drops, or
 * duplicates existing messages; the caller persists nothing.
 */
export function maybeInjectSnapshot(
  branch: readonly unknown[],
  messages: readonly ContextMessage[]
): ContextMessage[] | undefined {
  const snapshot = findBranchSnapshot(branch);
  if (snapshot === undefined || !hasUnfinishedWork(snapshot)) {
    return undefined;
  }
  if (retainedHasSnapshot(messages, snapshot)) return undefined;
  return [
    ...messages,
    buildSnapshotMessage(snapshot, buildSnapshotText(snapshot)),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
