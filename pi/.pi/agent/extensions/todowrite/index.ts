/**
 * todowrite - Token-efficient session-local todo tool for pi.
 *
 * State is intentionally runtime-only. The LLM sees current todos through tool
 * results in conversation history, and the optional widget is purely visual.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TodoWriteParams, MAX_CONTENT_LENGTH, MAX_TODOS, VALID_STATUSES } from "./schema.js";
import { buildDetails, resetTodoState, setTodos as replaceTodos } from "./state.js";
import { renderTodoCall, renderTodoResult } from "./renderers.js";
import type { Todo } from "./types.js";
import { clearWidget, refreshWidget, toggleWidget } from "./widget.js";

const TOGGLE_WIDGET_SHORTCUT = "alt+t";

/** Exported for orchestrator/UI access without coupling to the tool surface. */
export { getTodos, setTodos } from "./state.js";

/** Register the todowrite tool, shortcut, and widget refresh hook. */
export default function (pi: ExtensionAPI) {
  pi.registerShortcut(TOGGLE_WIDGET_SHORTCUT, {
    description: "Show or hide the todowrite widget",
    handler: async (ctx) => {
      toggleWidget(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    resetTodoState();
    clearWidget(ctx);
  });

  pi.registerTool({
    name: "todowrite",
    label: "Todo Write",
    description: [
      "Use this tool to maintain a short todo list for the current coding session.",
      "",
      "Use it when:",
      "- the task has 3+ meaningful steps",
      "- the user requests multiple changes",
      "- progress tracking would help avoid losing context",
      "",
      "Rules:",
      "- Keep todos short and actionable.",
      "- Only one todo should be in_progress.",
      "- Mark completed todos as soon as they are done.",
      "- Do not use for trivial one-step tasks.",
      "- Always rewrite the full current todo list.",
      "- Do not store long explanations, notes, logs, or history in todos.",
    ].join("\n"),
    promptSnippet: "Track session progress with a todo list",
    promptGuidelines: [
      "Use todowrite when the task has 3+ meaningful steps or the user requests multiple changes.",
      "Keep todos short and actionable with todowrite. Only one todo should be in_progress at a time.",
      "Always rewrite the full todo list with todowrite. Do not use for trivial one-step tasks.",
    ],
    parameters: TodoWriteParams,

    execute(_toolCallId, params) {
      const validation = normalizeTodos(params.todos);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: validation.error }],
          isError: true,
          details: {},
        };
      }

      replaceTodos(validation.todos);
      return {
        content: [{ type: "text", text: "Todo list updated." + buildSummary(validation.todos) }],
        details: buildDetails(validation.todos),
      };
    },

    renderCall: renderTodoCall,
    renderResult: renderTodoResult,
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "todowrite") {
      refreshWidget(ctx);
    }
  });
}

/** Normalize and validate a full replacement todo list. */
function normalizeTodos(rawTodos: unknown): { ok: true; todos: Todo[] } | { ok: false; error: string } {
  if (!Array.isArray(rawTodos)) {
    return { ok: false, error: "Error: todos must be an array." };
  }

  if (rawTodos.length > MAX_TODOS) {
    return { ok: false, error: `Error: Maximum ${MAX_TODOS} todos allowed (got ${rawTodos.length}).` };
  }

  const normalized: Todo[] = [];
  let inProgressCount = 0;

  for (let index = 0; index < rawTodos.length; index += 1) {
    const raw = (rawTodos[index] ?? {}) as Partial<Todo>;
    const content = (raw.content ?? "").trim();

    if (!content) {
      return { ok: false, error: `Error: Todo at index ${index} has empty content.` };
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      return {
        ok: false,
        error: `Error: Todo content exceeds ${MAX_CONTENT_LENGTH} characters: "${content.slice(0, 40)}..."`,
      };
    }

    const status = raw.status ?? "pending";
    if (!VALID_STATUSES.has(status)) {
      return { ok: false, error: `Error: Invalid status "${status}". Must be pending, in_progress, or completed.` };
    }

    if (status === "in_progress") {
      inProgressCount += 1;
    }

    if (inProgressCount > 1) {
      return { ok: false, error: "Error: Only one todo may be in_progress at a time." };
    }

    normalized.push({ content, status });
  }

  return { ok: true, todos: normalized };
}

/** Build compact text so the LLM can see the current todo list in tool results. */
function buildSummary(todos: Todo[]): string {
  const summaryLines = todos.map((todo) => {
    if (todo.status === "in_progress") return `> ${todo.content}`;
    if (todo.status === "completed") return `[x] ${todo.content}`;
    return `[ ] ${todo.content}`;
  });

  return summaryLines.length > 0 ? "\n" + summaryLines.join("\n") : " (empty)";
}
