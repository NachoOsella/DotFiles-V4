/** Session-local, branch-aware todo tracking for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { renderTodoCall, renderTodoResult } from "./renderers.ts";
import { TodoWriteParams } from "./schema.ts";
import {
  buildDetails,
  getTodos,
  removeSessionState,
  setTodos,
} from "./state.ts";
import type { Todo } from "./types.ts";
import { decodeStoredTodos, validateTodos } from "./validation.ts";
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
      "Use todowrite for tasks with at least three meaningful steps or multiple requested changes.",
      "Give each todo a stable unique ID within the current plan. Keep the same ID when rewriting its content.",
      "Keep the todo list synchronized with actual progress. Do not batch lifecycle updates at the end of the task.",
      "Prefer pending -> in_progress -> completed. A pending todo may be completed directly when work finishes before the list is synchronized.",
      "While unfinished work remains, normally keep exactly one todo in_progress.",
      "If discoveries change the plan, add, remove, reorder, or rewrite future pending todos. Todo content may also be clarified while work is in_progress.",
      "Always submit the complete replacement todo list, including completed todos while the plan remains active. After every todo is completed, the next replacement starts a new plan.",
    ],
    parameters: TodoWriteParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const todos = await Effect.runPromise(
        validateTodos(params.todos, getTodos(sessionId))
      );
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

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === TOOL_NAME && !event.isError) refreshWidget(ctx);
  });
}

/** Restore the first valid todo snapshot on the active branch. */
export function restoreTodos(
  sessionId: string,
  entries: readonly unknown[]
): void {
  setTodos(sessionId, []);

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      continue;
    const message = entry.message;
    if (
      message.role !== "toolResult" ||
      message.toolName !== TOOL_NAME ||
      !isRecord(message.details)
    ) {
      continue;
    }

    const restored = decodeStoredTodos(message.details.items);
    if (restored) {
      setTodos(sessionId, restored);
      return;
    }
  }
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
