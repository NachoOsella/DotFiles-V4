/**
 * todowrite - Token-efficient session-local todo tool for pi
 *
 * Inspired by OpenCode's todowrite tool, but significantly more minimal:
 * - No persistence (runtime memory only)
 * - No separate todoread tool (state lives in tool results)
 * - No database, no files, no user config
 * - One tool with replace-all semantics
 * - No automatic prompt injection (orchestrator decides)
 * - Compact schema, compact descriptions
 *
 * State: module-level variable, cleared on session_start.
 * The LLM sees todos through tool execution results in conversation history.
 */

import type { ExtensionAPI, Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TodoDetails {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  current: string | null;
  items: Todo[];
}

// ---------------------------------------------------------------------------
// Session-local state (module-level, cleared on session_start)
// ---------------------------------------------------------------------------

let todos: Todo[] = [];

/**
 * Exported for orchestrator/UI access without coupling to the tool surface.
 * The orchestrator can read this to inject compact summaries when useful.
 */
export function getTodos(): ReadonlyArray<Todo> {
  return todos;
}

/**
 * Exported for orchestrator to set todos (e.g., on session restore).
 */
export function setTodos(list: Todo[]): void {
  todos = list;
}

// ---------------------------------------------------------------------------
// TUI widget: displays todos above the editor line
// ---------------------------------------------------------------------------

/**
 * Returns true when the widget should stay visible.
 * Completed-only or empty lists are considered finished and hidden.
 */
function shouldShowWidget(): boolean {
  return todos.some((todo) => todo.status !== "completed");
}

/**
 * Builds a compact Codex-style checklist widget.
 * Returns empty array when there are no visible todos (hides the widget).
 */
function buildWidgetLines(theme: Theme, width: number): string[] {
  if (!shouldShowWidget()) return [];

  const titleText = "todos";
  const maxItemWidth = todos.reduce((max, todo) => {
    return Math.max(max, visibleWidth(todo.content) + 2);
  }, visibleWidth(titleText));

  // Keep the panel content-sized, but cap it so long todos do not dominate the terminal.
  const panelWidth = Math.min(width, Math.max(18, Math.min(maxItemWidth + 4, 72)));
  const innerWidth = Math.max(10, panelWidth - 4);
  const title = theme.fg("muted", titleText);
  const topPrefix = "╭─ ";
  const topSuffixWidth = Math.max(0, panelWidth - visibleWidth(topPrefix + titleText) - 1);
  const top = theme.fg("borderMuted", topPrefix) + title + theme.fg("borderMuted", "─".repeat(topSuffixWidth) + "╮");
  const bottom = theme.fg("borderMuted", "╰" + "─".repeat(Math.max(0, panelWidth - 2)) + "╯");

  const lines: string[] = [top];

  for (const todo of todos) {
    let marker: string;
    let text: string;

    if (todo.status === "in_progress") {
      marker = theme.fg("accent", "→");
      text = theme.fg("text", todo.content);
    } else if (todo.status === "completed") {
      marker = theme.fg("success", "✓");
      text = theme.fg("dim", theme.strikethrough(todo.content));
    } else {
      marker = theme.fg("dim", "□");
      text = theme.fg("muted", todo.content);
    }

    const content = truncateToWidth(marker + " " + text, innerWidth);
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
    lines.push(theme.fg("borderMuted", "│ ") + content + padding + theme.fg("borderMuted", " │"));
  }

  lines.push(bottom);
  return lines;
}

/**
 * Refresh the widget to match current todo state.
 */
function refreshWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (!shouldShowWidget()) {
    clearWidget(ctx);
    return;
  }

  ctx.ui.setWidget("todowrite", (_tui, theme) => ({
    render(width: number): string[] {
      return buildWidgetLines(theme, width);
    },
    invalidate(): void {},
  }));
}

/**
 * Clear the widget (no todos to display).
 */
function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("todowrite", undefined);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TODOS = 20;
const MAX_CONTENT_LENGTH = 200;
const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDetails(list: Todo[]): TodoDetails {
  const pending = list.filter((t) => t.status === "pending").length;
  const inProgress = list.filter((t) => t.status === "in_progress").length;
  const completed = list.filter((t) => t.status === "completed").length;
  const current = list.find((t) => t.status === "in_progress")?.content ?? null;
  return {
    total: list.length,
    pending,
    in_progress: inProgress,
    completed,
    current,
    items: list,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TodoSchema = Type.Object({
  content: Type.String({ description: "Brief description of the task" }),
  status: StringEnum(["pending", "in_progress", "completed"] as const, {
    description: "Current status of the task",
  }),
});

const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoSchema, {
    description: "Complete replacement todo list for the session",
  }),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Clear state and widget on session start (no persistence across sessions)
  pi.on("session_start", async (_event, ctx) => {
    todos = [];
    clearWidget(ctx);
  });

  pi.registerTool({
    name: "todowrite",
    label: "Todo Write",
    description: [
      'Use this tool to maintain a short todo list for the current coding session.',
      '',
      'Use it when:',
      '- the task has 3+ meaningful steps',
      '- the user requests multiple changes',
      '- progress tracking would help avoid losing context',
      '',
      'Rules:',
      '- Keep todos short and actionable.',
      '- Only one todo should be in_progress.',
      '- Mark completed todos as soon as they are done.',
      '- Do not use for trivial one-step tasks.',
      '- Always rewrite the full current todo list.',
      '- Do not store long explanations, notes, logs, or history in todos.',
    ].join('\n'),
    promptSnippet: 'Track session progress with a todo list',
    promptGuidelines: [
      'Use todowrite when the task has 3+ meaningful steps or the user requests multiple changes.',
      'Keep todos short and actionable with todowrite. Only one todo should be in_progress at a time.',
      'Always rewrite the full todo list with todowrite. Do not use for trivial one-step tasks.',
    ],
    parameters: TodoWriteParams,

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Validate: must be an array (schema should enforce this, but be safe)
      if (!Array.isArray(params.todos)) {
        return {
          content: [{ type: 'text', text: 'Error: todos must be an array.' }],
          isError: true,
          details: {},
        };
      }

      // Cap total count
      if (params.todos.length > MAX_TODOS) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Maximum ${MAX_TODOS} todos allowed (got ${params.todos.length}).`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      // Normalize and validate each todo
      const normalized: Todo[] = [];
      let inProgressCount = 0;

      for (let i = 0; i < params.todos.length; i++) {
        const raw = params.todos[i];
        const content = (raw.content ?? '').trim();

        if (!content) {
          return {
            content: [{ type: 'text', text: `Error: Todo at index ${i} has empty content.` }],
            isError: true,
            details: {},
          };
        }

        if (content.length > MAX_CONTENT_LENGTH) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Todo content exceeds ${MAX_CONTENT_LENGTH} characters: "${content.slice(0, 40)}..."`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        const status = raw.status ?? 'pending';

        if (!VALID_STATUSES.has(status)) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Invalid status "${status}". Must be pending, in_progress, or completed.`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        if (status === 'in_progress') {
          inProgressCount++;
        }

        if (inProgressCount > 1) {
          return {
            content: [{ type: 'text', text: 'Error: Only one todo may be in_progress at a time.' }],
            isError: true,
            details: {},
          };
        }

        normalized.push({ content, status: status as Todo['status'] });
      }

      // Full replacement
      todos = normalized;

      // Build compact text so the LLM can always see current todos.
      const summaryLines = todos.map((todo) => {
        if (todo.status === 'in_progress') return `> ${todo.content}`;
        if (todo.status === 'completed') return `[x] ${todo.content}`;
        return `[ ] ${todo.content}`;
      });
      const summary = summaryLines.length > 0
        ? '\n' + summaryLines.join('\n')
        : ' (empty)';

      // The tool_result event handler will refresh the widget,
      // so we don't need to do it here.

      return {
        content: [{ type: 'text', text: 'Todo list updated.' + summary }],
        details: buildDetails(todos),
      };
    },

    // -----------------------------------------------------------------------
    // TUI rendering (purely visual, does not affect context tokens)
    // -----------------------------------------------------------------------

    renderCall(args: { todos?: Todo[] }, theme: Theme) {
      const count = (args.todos ?? []).length;
      return new Text(
        theme.fg('toolTitle', 'todowrite ') + theme.fg('muted', String(count)),
        0, 0,
      );
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown },
      { expanded }: { expanded: boolean },
      theme: Theme,
    ) {
      if (result.isError) {
        return new Text(
          theme.fg('error', result.content[0]?.type === 'text' ? (result.content[0].text ?? 'Error') : 'Error'),
          0, 0,
        );
      }

      const details = result.details as TodoDetails | undefined;

      if (!details || details.total === 0) {
        return new Text(theme.fg('dim', '0'), 0, 0);
      }

      // Collapsed: single-line summary
      //  > Refactor  +2  \u27131
      const parts: string[] = [];
      if (details.current) {
        parts.push(theme.fg('accent', '>') + theme.fg('text', ' ' + details.current));
      }
      if (details.pending > 0) {
        parts.push(theme.fg('dim', '+' + details.pending));
      }
      if (details.completed > 0) {
        parts.push(theme.fg('success', '\u2713' + details.completed));
      }

      if (!expanded) {
        return new Text(parts.join('  '), 0, 0);
      }

      // Expanded: show all items with box indicators
      //  > Refactor  +2  \u27131
      //
      //  > Refactor database layer
      //  [ ] Add tests
      //  [\u2713] Update docs  (strikethrough)
      const lines: string[] = [parts.join('  '), ''];

      for (const item of details.items) {
        if (item.status === 'in_progress') {
          lines.push(theme.fg('accent', '  > ') + theme.fg('text', item.content));
        } else if (item.status === 'completed') {
          lines.push(
            theme.fg('success', '  [\u2713] ') + theme.fg('dim', theme.strikethrough(item.content)),
          );
        } else {
          lines.push(theme.fg('dim', '  [ ] ') + theme.fg('dim', item.content));
        }
      }

      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // Refresh the TUI widget after every todowrite tool execution
  // -----------------------------------------------------------------------

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === 'todowrite') {
      refreshWidget(ctx);
    }
  });
}
