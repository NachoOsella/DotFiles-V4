import type { Todo, TodoDetails } from "./types.js";

let todos: Todo[] = [];
let widgetVisible = false;

/** Return the current session-local todo list. */
export function getTodos(): ReadonlyArray<Todo> {
  return todos;
}

/** Replace the current session-local todo list. */
export function setTodos(list: Todo[]): void {
  todos = list;
}

/** Reset todos and widget visibility for a new session. */
export function resetTodoState(): void {
  todos = [];
  widgetVisible = false;
}

/** Return whether the widget is enabled by the user. */
export function isWidgetVisible(): boolean {
  return widgetVisible;
}

/** Set whether the widget is enabled by the user. */
export function setWidgetVisible(visible: boolean): void {
  widgetVisible = visible;
}

/** Toggle widget visibility and return the new value. */
export function toggleWidgetVisible(): boolean {
  widgetVisible = !widgetVisible;
  return widgetVisible;
}

/** Return true when there are active todos worth showing. */
export function hasVisibleTodos(): boolean {
  return todos.some((todo) => todo.status !== "completed");
}

/** Build aggregate details for tool result rendering and session history. */
export function buildDetails(list: Todo[]): TodoDetails {
  const pending = list.filter((todo) => todo.status === "pending").length;
  const inProgress = list.filter((todo) => todo.status === "in_progress").length;
  const completed = list.filter((todo) => todo.status === "completed").length;
  const current = list.find((todo) => todo.status === "in_progress")?.content ?? null;
  return {
    total: list.length,
    pending,
    in_progress: inProgress,
    completed,
    current,
    items: list,
  };
}
