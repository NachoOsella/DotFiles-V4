/** A single session-local todo item. */
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Aggregated todo data stored in tool result details. */
export interface TodoDetails {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  current: string | null;
  items: Todo[];
}
