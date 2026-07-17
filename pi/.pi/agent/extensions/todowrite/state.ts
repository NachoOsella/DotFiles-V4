import type { Todo, TodoDetails } from "./types.ts";

let todos: readonly Todo[] = [];
let widgetVisible = false;

/** Return an immutable snapshot of the current session todo list. */
export function getTodos(): readonly Todo[] {
  return todos;
}

/** Replace the current todo list with an immutable defensive copy. */
export function setTodos(list: readonly Todo[]): void {
  todos = list.map((todo) => ({ ...todo }));
}

/** Reset runtime state before restoring a session branch. */
export function resetTodoState(): void {
  todos = [];
  widgetVisible = false;
}

/** Return whether the widget is enabled by the user. */
export function isWidgetVisible(): boolean {
  return widgetVisible;
}

/** Toggle widget visibility and return the new value. */
export function toggleWidgetVisible(): boolean {
  widgetVisible = !widgetVisible;
  return widgetVisible;
}

/** Return true when there are incomplete todos worth showing. */
export function hasVisibleTodos(): boolean {
  return todos.some((todo) => todo.status !== "completed");
}

/** Build aggregate details for rendering and branch-aware state restoration. */
export function buildDetails(list: readonly Todo[]): TodoDetails {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let current: string | null = null;

  for (const todo of list) {
    if (todo.status === "pending") pending += 1;
    if (todo.status === "completed") completed += 1;
    if (todo.status === "in_progress") {
      inProgress += 1;
      current = todo.content;
    }
  }

  return {
    total: list.length,
    pending,
    in_progress: inProgress,
    completed,
    current,
    items: list.map((todo) => ({ ...todo })),
  };
}
