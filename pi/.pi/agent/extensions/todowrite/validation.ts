import { Data, Effect } from "effect";
import { MAX_CONTENT_LENGTH, MAX_TODOS, VALID_STATUSES } from "./schema.ts";
import type { Todo, TodoStatus } from "./types.ts";

/** Describes invalid todo input without exposing Effect internals to callers. */
export class TodoValidationError extends Data.TaggedError(
  "TodoValidationError"
)<{
  readonly message: string;
}> {}

/** Normalize and validate a complete replacement todo list. */
export function validateTodos(
  rawTodos: unknown
): Effect.Effect<readonly Todo[], TodoValidationError> {
  return Effect.gen(function* () {
    const decoded = decodeTodoList(rawTodos);
    if (!decoded.ok) return yield* invalid(decoded.message);
    return decoded.todos;
  });
}

/** Safely decode todo items previously stored in tool result details. */
export function decodeStoredTodos(value: unknown): readonly Todo[] | undefined {
  const decoded = decodeTodoList(value);
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
  let inProgressCount = 0;

  for (const [index, rawTodo] of rawTodos.entries()) {
    if (!isRecord(rawTodo)) {
      return {
        ok: false,
        message: `Todo at index ${index} must be an object.`,
      };
    }

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

    todos.push({ content, status });
  }

  return { ok: true, todos };
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
