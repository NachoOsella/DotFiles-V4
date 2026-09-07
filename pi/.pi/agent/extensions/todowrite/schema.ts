import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { TodoStatus } from "./types.ts";

/** Maximum number of todos accepted in a single replacement list. */
export const MAX_TODOS = 20;

/** Maximum ID length for one todo. */
export const MAX_ID_LENGTH = 50;

/** Maximum text length for one todo. */
export const MAX_CONTENT_LENGTH = 200;

/** Status values accepted by the todowrite tool. */
export const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

/** JSON schema for one todo item. */
const TodoSchema = Type.Object({
  id: Type.String({
    description:
      "Stable unique identity within the current plan, such as \"1\". Reuse the same ID for a task in every later update. Never renumber IDs or reuse an ID for different work. Maximum 50 characters.",
    minLength: 1,
    maxLength: MAX_ID_LENGTH,
    pattern: "\\S",
  }),
  content: Type.String({
    description:
      "Brief description of the task. Maximum 200 characters.",
    minLength: 1,
    maxLength: MAX_CONTENT_LENGTH,
    pattern: "\\S",
  }),
  status: StringEnum(["pending", "in_progress", "completed"] as const, {
    description: "Current status of the task",
  }),
});

/** JSON schema for the todowrite tool parameters. */
export const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoSchema, {
    description:
      "Complete replacement todo list for the session. Resubmit every item on each call, including completed ones. Never submit only the changed item. Maximum 20 todos.",
    maxItems: MAX_TODOS,
  }),
});

/** Validated parameter type accepted by the todowrite tool. */
export type TodoWriteInput = Static<typeof TodoWriteParams>;
