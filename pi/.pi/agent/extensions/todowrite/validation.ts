import { Data, Effect } from "effect";
import { MAX_CONTENT_LENGTH, MAX_TODOS, VALID_STATUSES } from "./schema.ts";
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
  const seenContents = new Set<string>();
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
    if (seenContents.has(content)) {
      return {
        ok: false,
        message: `Todo at index ${index} duplicates another todo.`,
      };
    }
    seenContents.add(content);

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

/** Validate lifecycle changes while leaving future pending work flexible. */
function validateTransitions(
  previousTodos: readonly Todo[],
  nextTodos: readonly Todo[]
): string | undefined {
  // An empty list is an explicit clear, including after a completed task.
  if (previousTodos.length === 0 || nextTodos.length === 0) return undefined;

  const previousByContent = new Map(
    previousTodos.map((todo) => [todo.content, todo] as const)
  );
  const nextContents = new Set(nextTodos.map((todo) => todo.content));

  for (const todo of nextTodos) {
    const previous = previousByContent.get(todo.content);
    if (!previous) {
      // New or replanned work may start pending or in_progress, never completed.
      if (todo.status === "completed") {
        return `Todo "${todo.content}" must be in_progress before it can be completed.`;
      }
      continue;
    }

    if (previous.status === "pending" && todo.status === "completed") {
      return `Todo "${todo.content}" cannot move from pending to completed; mark it in_progress first.`;
    }
    if (previous.status === "in_progress" && todo.status === "pending") {
      return `Todo "${todo.content}" is in_progress and must be completed before it is returned to pending.`;
    }
    if (previous.status === "completed" && todo.status !== "completed") {
      return `Completed todo "${todo.content}" must remain completed.`;
    }
  }

  for (const todo of previousTodos) {
    if (nextContents.has(todo.content)) continue;
    if (todo.status === "in_progress") {
      return `In-progress todo "${todo.content}" must remain in the list until it is completed.`;
    }
    if (todo.status === "completed") {
      return `Completed todo "${todo.content}" must remain in the list and completed.`;
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
