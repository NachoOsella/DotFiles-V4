import { Data, Effect } from "effect";
import {
  MAX_CONTENT_LENGTH,
  MAX_ID_LENGTH,
  MAX_TODOS,
  VALID_STATUSES,
} from "./schema.ts";
import type { Todo, TodoStatus } from "./types.ts";

/** Describes invalid todo input without exposing Effect internals to callers. */
export class TodoValidationError extends Data.TaggedError(
  "TodoValidationError"
)<{
  readonly message: string;
}> {}

/** Normalize and validate a replacement list against the current session state. */
export function validateTodos(
  rawTodos: unknown,
  previousTodos: readonly Todo[] = []
): Effect.Effect<readonly Todo[], TodoValidationError> {
  return Effect.gen(function* () {
    const decoded = decodeTodoList(rawTodos);
    if (!decoded.ok) return yield* invalid(decoded.message);

    const transitionError = validateTransitions(previousTodos, decoded.todos);
    if (transitionError) return yield* invalid(transitionError);

    return decoded.todos;
  });
}

/** Maximum bytes for the current-state echo appended to transition errors. */
export const MAX_STATE_ECHO_BYTES = 2048;

/**
 * Render the current list compactly so a rejected update shows what to
 * resubmit. IDs come first because they are the identities validation uses.
 */
export function echoCurrentState(previousTodos: readonly Todo[]): string {
  if (previousTodos.length === 0) return " Current list is empty.";
  const parts = previousTodos.map((todo) => {
    const content =
      [...todo.content].length > 80
        ? `${[...todo.content].slice(0, 80).join("")}...`
        : todo.content;
    return `[${todo.id}] ${todo.status} ${JSON.stringify(content)}`;
  });
  const full = ` Current list: ${parts.join(", ")}. Resubmit the full list with your change applied.`;
  if (new TextEncoder().encode(full).length <= MAX_STATE_ECHO_BYTES)
    return full;
  let truncated = full;
  while (
    new TextEncoder().encode(`${truncated}...`).length >
      MAX_STATE_ECHO_BYTES &&
    truncated.length > 0
  ) {
    truncated = truncated.slice(0, -64);
  }
  return `${truncated}...`;
}

/**
 * Scan branch entries newest-first for the latest valid successful todo
 * snapshot. Shared by session restoration and context injection so both
 * agree on the canonical state. Error results never become authoritative.
 */
export function findLatestSuccessfulSnapshot(
  branch: readonly unknown[]
): readonly Todo[] | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      continue;
    const message = entry.message;
    if (
      message.role !== "toolResult" ||
      message.toolName !== "todowrite" ||
      message.isError ||
      !isRecord(message.details)
    ) {
      continue;
    }
    const snapshot = decodeStoredTodos(message.details.items);
    if (snapshot) return snapshot;
  }
  return undefined;
}

/** Normalize one todo for structural snapshot comparison. */
function snapshotKey(todo: Todo): string {
  return `${todo.id.trim()}\0${todo.status}\0${todo.content.trim()}`;
}

/**
 * Compare snapshots by normalized ID, status, content, and order.
 * Shared by replay detection and context deduplication so both agree on
 * what counts as the same snapshot.
 */
export function snapshotsEqualTodos(
  left: readonly Todo[],
  right: readonly Todo[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((todo, index) => {
    const other = right[index];
    return other !== undefined && snapshotKey(todo) === snapshotKey(other);
  });
}

/** Safely decode todo items previously stored in tool result details. */
export function decodeStoredTodos(value: unknown): readonly Todo[] | undefined {
  if (!Array.isArray(value)) return undefined;

  // Older snapshots predate stable IDs. Assign their list positions once so
  // restored active work still participates in lifecycle validation.
  const withIds = value.map((item, index) =>
    isRecord(item) && item.id === undefined
      ? { ...item, id: String(index + 1) }
      : item
  );
  const decoded = decodeTodoList(withIds);
  return decoded.ok ? decoded.todos : undefined;
}

type TodoDecodeResult =
  | { readonly ok: true; readonly todos: readonly Todo[] }
  | { readonly ok: false; readonly message: string };

/** Apply the same normalization and invariants to new and stored todo lists. */
function decodeTodoList(rawTodos: unknown): TodoDecodeResult {
  if (!Array.isArray(rawTodos))
    return { ok: false, message: "Todos must be an array." };
  if (rawTodos.length > MAX_TODOS) {
    return {
      ok: false,
      message: `Maximum ${MAX_TODOS} todos allowed (got ${rawTodos.length}).`,
    };
  }

  const todos: Todo[] = [];
  const seenIds = new Set<string>();
  let inProgressCount = 0;

  for (const [index, rawTodo] of rawTodos.entries()) {
    if (!isRecord(rawTodo)) {
      return {
        ok: false,
        message: `Todo at index ${index} must be an object.`,
      };
    }

    const rawId = typeof rawTodo.id === "string" ? rawTodo.id : "";
    if ([...rawId].length > MAX_ID_LENGTH) {
      return {
        ok: false,
        message: `Todo at index ${index} has an ID longer than ${MAX_ID_LENGTH} characters.`,
      };
    }

    const id = rawId.trim();
    if (!id) {
      return {
        ok: false,
        message: `Todo at index ${index} has an empty ID.`,
      };
    }
    if (seenIds.has(id)) {
      return {
        ok: false,
        message: `Todo at index ${index} duplicates ID ${JSON.stringify(id)}.`,
      };
    }
    seenIds.add(id);

    const rawContent =
      typeof rawTodo.content === "string" ? rawTodo.content : "";
    if ([...rawContent].length > MAX_CONTENT_LENGTH) {
      return {
        ok: false,
        message: `Todo at index ${index} exceeds ${MAX_CONTENT_LENGTH} characters.`,
      };
    }

    const content = rawContent.trim();
    if (!content)
      return {
        ok: false,
        message: `Todo at index ${index} has empty content.`,
      };
    const status = rawTodo.status;
    if (!isTodoStatus(status)) {
      return {
        ok: false,
        message: `Todo at index ${index} has invalid status ${JSON.stringify(status)}.`,
      };
    }
    if (status === "in_progress" && ++inProgressCount > 1) {
      return {
        ok: false,
        message: "Only one todo may be in_progress at a time.",
      };
    }

    todos.push({ id, content, status });
  }

  return { ok: true, todos };
}

/** Validate lifecycle changes while leaving future pending work flexible. */
function validateTransitions(
  previousTodos: readonly Todo[],
  nextTodos: readonly Todo[]
): string | undefined {
  if (nextTodos.length === 0) {
    const active = previousTodos.find((todo) => todo.status === "in_progress");
    return active
      ? `In-progress todo ${JSON.stringify(active.id)} must be completed or paused back to pending before clearing the list.${echoCurrentState(previousTodos)}`
      : undefined;
  }

  // Replaying the exact normalized completed snapshot is not a new plan.
  // Accept it so retries after a closed plan do not fail validation.
  if (
    previousTodos.length > 0 &&
    previousTodos.every((todo) => todo.status === "completed") &&
    isIdenticalSnapshot(previousTodos, nextTodos)
  ) {
    return undefined;
  }

  // Once every item is completed, the plan is closed. The next non-empty
  // replacement starts a fresh plan, so short IDs may be reused safely.
  const activePlanTodos = previousTodos.every(
    (todo) => todo.status === "completed"
  )
    ? []
    : previousTodos;
  const previousById = new Map(
    activePlanTodos.map((todo) => [todo.id, todo] as const)
  );
  const nextIds = new Set(nextTodos.map((todo) => todo.id));

  for (const todo of nextTodos) {
    const previous = previousById.get(todo.id);
    if (!previous) {
      // New or replacement work may start pending or in_progress, never completed.
      // Pending work may complete directly, so new work starts pending/in_progress first.
      if (todo.status === "completed") {
        return `Todo ${JSON.stringify(todo.id)} cannot start as completed. Start new work as pending or in_progress, then complete it in a later update.${echoCurrentState(previousTodos)}`;
      }
      continue;
    }

    // Paused work may return from in_progress to pending. Only completion
    // is terminal within an active plan.
    if (previous.status === "completed" && todo.status !== "completed") {
      return `Completed todo ${JSON.stringify(todo.id)} must remain completed. Resubmit it unchanged with the rest of the full list.${echoCurrentState(previousTodos)}`;
    }
  }

  for (const todo of activePlanTodos) {
    if (nextIds.has(todo.id)) continue;
    if (todo.status === "in_progress") {
      return `In-progress todo ${JSON.stringify(todo.id)} must remain in the list until it is completed or paused back to pending.${echoCurrentState(previousTodos)}`;
    }
    if (todo.status === "completed") {
      return `Completed todo ${JSON.stringify(todo.id)} must remain in the list and completed.${echoCurrentState(previousTodos)}`;
    }
  }

  return undefined;
}

/** Compare normalized ID, content, status, and order for replay detection. */
function isIdenticalSnapshot(
  previousTodos: readonly Todo[],
  nextTodos: readonly Todo[]
): boolean {
  return snapshotsEqualTodos(previousTodos, nextTodos);
}

function invalid(message: string): Effect.Effect<never, TodoValidationError> {
  return Effect.fail(new TodoValidationError({ message }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as TodoStatus);
}
