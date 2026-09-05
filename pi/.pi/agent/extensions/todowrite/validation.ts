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
      ? `In-progress todo ${JSON.stringify(active.id)} must be completed before clearing the list.`
      : undefined;
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
      if (todo.status === "completed") {
        return `Todo ${JSON.stringify(todo.id)} must be in_progress before it can be completed.`;
      }
      continue;
    }

    if (previous.status === "in_progress" && todo.status === "pending") {
      return `Todo ${JSON.stringify(todo.id)} is in_progress and must be completed before it is returned to pending.`;
    }
    if (previous.status === "completed" && todo.status !== "completed") {
      return `Completed todo ${JSON.stringify(todo.id)} must remain completed.`;
    }
  }

  for (const todo of activePlanTodos) {
    if (nextIds.has(todo.id)) continue;
    if (todo.status === "in_progress") {
      return `In-progress todo ${JSON.stringify(todo.id)} must remain in the list until it is completed.`;
    }
    if (todo.status === "completed") {
      return `Completed todo ${JSON.stringify(todo.id)} must remain in the list and completed.`;
    }
  }

  return undefined;
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
