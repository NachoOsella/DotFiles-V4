import { Data, Effect } from "effect";
import { MAX_CONTENT_LENGTH, MAX_TODOS, VALID_STATUSES } from "./schema.ts";
import type { Todo, TodoStatus } from "./types.ts";

/** Describes invalid todo input without exposing Effect internals to callers. */
export class TodoValidationError extends Data.TaggedError("TodoValidationError")<{
  readonly message: string;
}> {}

/** Normalize and validate a complete replacement todo list. */
export function validateTodos(rawTodos: unknown): Effect.Effect<readonly Todo[], TodoValidationError> {
  return Effect.gen(function* () {
    if (!Array.isArray(rawTodos)) {
      return yield* invalid("Todos must be an array.");
    }
    if (rawTodos.length > MAX_TODOS) {
      return yield* invalid(`Maximum ${MAX_TODOS} todos allowed (got ${rawTodos.length}).`);
    }

    const todos: Todo[] = [];
    let inProgressCount = 0;

    for (const [index, rawTodo] of rawTodos.entries()) {
      if (!isRecord(rawTodo)) {
        return yield* invalid(`Todo at index ${index} must be an object.`);
      }

      const content = typeof rawTodo.content === "string" ? rawTodo.content.trim() : "";
      if (!content) {
        return yield* invalid(`Todo at index ${index} has empty content.`);
      }
      if (content.length > MAX_CONTENT_LENGTH) {
        return yield* invalid(
          `Todo at index ${index} exceeds ${MAX_CONTENT_LENGTH} characters.`,
        );
      }

      const status = rawTodo.status;
      if (!isTodoStatus(status)) {
        return yield* invalid(
          `Todo at index ${index} has invalid status ${JSON.stringify(status)}.`,
        );
      }
      if (status === "in_progress" && ++inProgressCount > 1) {
        return yield* invalid("Only one todo may be in_progress at a time.");
      }

      todos.push({ content, status });
    }

    return todos;
  });
}

/** Safely decode todo items previously stored in tool result details. */
export function decodeStoredTodos(value: unknown): readonly Todo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: Todo[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.content !== "string" || !isTodoStatus(item.status)) {
      return undefined;
    }
    todos.push({ content: item.content, status: item.status });
  }
  return todos;
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
