/** Supported lifecycle states for a todo item. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** A single session-local todo item. */
export interface Todo {
  readonly content: string;
  readonly status: TodoStatus;
}

/** Aggregated todo data stored in tool result details. */
export interface TodoDetails {
  readonly total: number;
  readonly pending: number;
  readonly in_progress: number;
  readonly completed: number;
  readonly current: string | null;
  readonly items: readonly Todo[];
}
