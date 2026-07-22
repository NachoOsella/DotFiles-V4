import type { Todo, TodoDetails } from "./types.ts";

/**
 * Per-session state keyed by session ID (ctx.sessionManager.getSessionId()).
 * This keeps todo lists isolated between the parent session and any in-process
 * subagent sessions, preventing accidental overwrites.
 */
const todosBySession = new Map<string, readonly Todo[]>();
const widgetVisibleBySession = new Map<string, boolean>();

/** Return an immutable snapshot of the current session todo list. */
export function getTodos(sessionId: string): readonly Todo[] {
  return todosBySession.get(sessionId) ?? [];
}

/** Replace the current session's todo list with an immutable defensive copy. */
export function setTodos(sessionId: string, list: readonly Todo[]): void {
  todosBySession.set(sessionId, list.map((todo) => ({ ...todo })));
}

/** Remove all state for a session (called on session_shutdown). */
export function removeSessionState(sessionId: string): void {
  todosBySession.delete(sessionId);
  widgetVisibleBySession.delete(sessionId);
}

/** Return whether the widget is enabled by the user for the given session. */
export function isWidgetVisible(sessionId: string): boolean {
  return widgetVisibleBySession.get(sessionId) ?? false;
}

/** Toggle widget visibility for the given session and return the new value. */
export function toggleWidgetVisible(sessionId: string): boolean {
  const current = widgetVisibleBySession.get(sessionId) ?? false;
  const next = !current;
  widgetVisibleBySession.set(sessionId, next);
  return next;
}

/** Return true when the given session has incomplete todos worth showing. */
export function hasVisibleTodos(sessionId: string): boolean {
  return getTodos(sessionId).some((todo) => todo.status !== "completed");
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
