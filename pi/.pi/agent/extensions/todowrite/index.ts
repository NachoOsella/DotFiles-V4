/** Session-local, branch-aware todo tracking for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { maybeInjectSnapshot } from "./context.ts";
import { renderTodoCall, renderTodoResult } from "./renderers.ts";
import { TodoWriteParams } from "./schema.ts";
import {
  buildDetails,
  getTodos,
  removeSessionState,
  setTodos,
} from "./state.ts";
import type { Todo } from "./types.ts";
import { findLatestSuccessfulSnapshot, validateTodos } from "./validation.ts";
import { clearWidget, refreshWidget, toggleWidget } from "./widget.ts";

const TOGGLE_WIDGET_SHORTCUT = "alt+t";
const TOOL_NAME = "todowrite";

export { getTodos, setTodos } from "./state.ts";

/** Register the todowrite tool and its optional session widget. */
export default function todowriteExtension(pi: ExtensionAPI) {
  pi.registerShortcut(TOGGLE_WIDGET_SHORTCUT, {
    description: "Show or hide the todowrite widget",
    handler: async (ctx) => toggleWidget(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    restoreTodos(sessionId, ctx.sessionManager.getBranch());
    refreshWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    restoreTodos(sessionId, ctx.sessionManager.getBranch());
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWidget(ctx);
    removeSessionState(ctx.sessionManager.getSessionId());
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo Write",
    description: "Maintain a live todo list for the current coding session.",
    promptSnippet: "Track progress through a multi-step task",
    promptGuidelines: [
      "Use todowrite for tasks with at least three meaningful steps or multiple requested changes. Maximum 20 todos per list and 200 characters per description.",
      "Always submit the complete replacement todo list on each todowrite call, including completed todos while the plan remains active. Never submit only the changed item. To complete task 1 of a two-item plan, submit the full list, for example [1] completed plus [2] pending. After every todo is completed, the next replacement starts a new plan.",
      "Give each todo a stable unique ID within the current plan and reuse the same ID in every later update. Never renumber IDs and never reuse an ID for different work.",
      "Keep the todo list synchronized with actual progress. Do not batch lifecycle updates at the end of the task. Prefer pending -> in_progress -> completed. A pending todo may be completed directly when work finishes before the list is synchronized. While unfinished work remains, normally keep exactly one todo in_progress.",
      "If discoveries change the plan, add, remove, reorder, or rewrite future pending todos. Todo content may also be clarified while work is in_progress. Paused work may return from in_progress to pending. Completed todos must stay completed and in the list while the plan remains active.",
    ],
    parameters: TodoWriteParams,
    executionMode: "sequential",
    prepareArguments: normalizeTodoArguments,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const sessionId = ctx.sessionManager.getSessionId();
      const todos = await Effect.runPromise(
        validateTodos(params.todos, getTodos(sessionId))
      );
      signal?.throwIfAborted();
      setTodos(sessionId, todos);
      return {
        content: [
          {
            type: "text" as const,
            text: `Todo list updated.${buildSummary(todos)}`,
          },
        ],
        details: buildDetails(todos),
      };
    },

    renderCall: renderTodoCall,
    renderResult: renderTodoResult,
  });

  pi.on("context", (event, ctx) => {
    const messages = maybeInjectSnapshot(
      ctx.sessionManager.getBranch(),
      event.messages
    );
    if (messages) return { messages };
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === TOOL_NAME && !event.isError) refreshWidget(ctx);
  });
}

/** Common status aliases models produce, mapped to the accepted values. */
const TODO_STATUS_ALIASES: Record<string, string> = {
  done: "completed",
  complete: "completed",
  completed: "completed",
  "in-progress": "in_progress",
  "in progress": "in_progress",
  inprogress: "in_progress",
  in_progress: "in_progress",
  pending: "pending",
  todo: "pending",
};

/** Normalize one raw todo item before schema validation. */
function normalizeTodoItem(rawTodo: unknown): unknown {
  if (!isRecord(rawTodo)) return rawTodo;
  const out: Record<string, unknown> = { ...rawTodo };
  if (typeof out.id === "number" && Number.isSafeInteger(out.id)) {
    out.id = String(out.id);
  }
  if (typeof out.status === "string") {
    const key = out.status.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (TODO_STATUS_ALIASES[key] !== undefined) {
      out.status = TODO_STATUS_ALIASES[key];
    }
  }
  return out;
}

/**
 * Tolerate the most common malformed calls before schema validation runs.
 * Wraps a single trailing object in an array, coerces numeric IDs to
 * strings, and maps status aliases such as "done" to the accepted values.
 * Anything still invalid is left for the schema and lifecycle validation.
 */
export function normalizeTodoArguments(args: any): any {
  if (!isRecord(args)) return args;
  let todos = args.todos;
  if (todos !== undefined && !Array.isArray(todos)) {
    if (!isRecord(todos)) return args;
    todos = [todos];
  }
  if (todos === undefined) return args;
  return { ...args, todos: (todos as unknown[]).map(normalizeTodoItem) };
}

/**
 * Restore the first valid successful todo snapshot on the active branch.
 * Error results never become authoritative, even with valid-looking items.
 */
export function restoreTodos(
  sessionId: string,
  entries: readonly unknown[]
): void {
  setTodos(sessionId, findLatestSuccessfulSnapshot(entries) ?? []);
}

/** Build compact state text for future model turns. */
function buildSummary(todos: readonly Todo[]): string {
  if (todos.length === 0) return " (empty)";
  return `\n${todos.map(formatTodo).join("\n")}`;
}

function formatTodo(todo: Todo): string {
  const label = `[${todo.id}] ${todo.content}`;
  if (todo.status === "in_progress") return `> ${label}`;
  if (todo.status === "completed") return `[x] ${label}`;
  return `[ ] ${label}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
