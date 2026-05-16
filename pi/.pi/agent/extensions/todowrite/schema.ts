import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Maximum number of todos accepted in a single replacement list. */
export const MAX_TODOS = 20;

/** Maximum text length for one todo. */
export const MAX_CONTENT_LENGTH = 200;

/** Status values accepted by the todowrite tool. */
export const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** JSON schema for one todo item. */
const TodoSchema = Type.Object({
  content: Type.String({ description: "Brief description of the task" }),
  status: StringEnum(["pending", "in_progress", "completed"] as const, {
    description: "Current status of the task",
  }),
});

/** JSON schema for the todowrite tool parameters. */
export const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoSchema, {
    description: "Complete replacement todo list for the session",
  }),
});
