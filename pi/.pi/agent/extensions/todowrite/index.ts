/** Session-local, branch-aware todo tracking for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { renderTodoCall, renderTodoResult } from "./renderers.ts";
import { TodoWriteParams } from "./schema.ts";
import { buildDetails, resetTodoState, setTodos } from "./state.ts";
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
    resetTodoState();
    restoreTodos(ctx.sessionManager.getBranch());
    clearWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWidget(ctx);
    resetTodoState();
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo Write",
    description: [
      "Maintain a short todo list for the current coding session.",
      "Use it for tasks with at least three meaningful steps or multiple requested changes.",
      "Always submit the complete replacement list and keep at most one item in_progress.",
    ].join(" "),
    promptSnippet: "Track session progress with a todo list",
    promptGuidelines: [
      "Use todowrite when the task has 3+ meaningful steps or the user requests multiple changes.",
      "Keep todos short and actionable with todowrite. Only one todo should be in_progress at a time.",
      "Always rewrite the full todo list with todowrite. Do not use it for trivial one-step tasks.",
    ],
    parameters: TodoWriteParams,

    async execute(_toolCallId, params) {
      const todos = await Effect.runPromise(validateTodos(params.todos));
      setTodos(todos);
      return {
        content: [{ type: "text" as const, text: `Todo list updated.${buildSummary(todos)}` }],
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

/** Restore the latest todo snapshot on the active branch. */
function restoreTodos(entries: readonly unknown[]): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== TOOL_NAME || !isRecord(message.details)) {
      continue;
    }

    const restored = decodeStoredTodos(message.details.items);
    if (restored) setTodos(restored);
    return;
  }
}

/** Build compact state text for future model turns. */
function buildSummary(todos: readonly Todo[]): string {
  if (todos.length === 0) return " (empty)";
  return `\n${todos.map(formatTodo).join("\n")}`;
}

function formatTodo(todo: Todo): string {
  if (todo.status === "in_progress") return `> ${todo.content}`;
  if (todo.status === "completed") return `[x] ${todo.content}`;
  return `[ ] ${todo.content}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
