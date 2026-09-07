import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { toSafeDisplayText } from "./renderers.ts";
import {
  getTodos,
  hasVisibleTodos,
  isWidgetVisible,
  toggleWidgetVisible,
} from "./state.ts";
import type { Todo } from "./types.ts";

/** Maximum active-work rows shown inside the widget panel. */
export const MAX_WIDGET_CONTENT_ROWS = 5;

/**
 * Constrain the content budget further on short terminals so the widget
 * never dominates the viewport. Unknown heights keep the full budget.
 */
export function contentRowBudget(terminalRows: number | undefined): number {
  if (
    typeof terminalRows !== "number" ||
    !Number.isFinite(terminalRows) ||
    terminalRows <= 0
  ) {
    return MAX_WIDGET_CONTENT_ROWS;
  }
  return Math.max(
    1,
    Math.min(MAX_WIDGET_CONTENT_ROWS, Math.floor(terminalRows / 4))
  );
}

/** Plain-text content rows for the widget: active work plus one summary. */
function buildContentRows(
  todos: readonly Todo[],
  budget: number
): { text: string; status: Todo["status"] | "summary"; id?: string }[] {
  const active = [
    ...todos.filter((todo) => todo.status === "in_progress"),
    ...todos.filter((todo) => todo.status === "pending"),
  ];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const total = todos.length;
  const needsSummary = completed > 0 || active.length > budget;
  const shownActive = needsSummary
    ? active.slice(0, Math.max(0, budget - 1))
    : active.slice(0, budget);

  const rows: {
    text: string;
    status: Todo["status"] | "summary";
    id?: string;
  }[] = shownActive.map((todo) => ({
    text: `[${toSafeDisplayText(todo.id)}] ${toSafeDisplayText(todo.content)}`,
    status: todo.status,
    id: todo.id,
  }));

  if (needsSummary) {
    const hidden = active.length - shownActive.length;
    const parts: string[] = [];
    if (hidden > 0) parts.push(`+${hidden} more`);
    if (total > 0) parts.push(`${completed}/${total} done`);
    rows.push({ text: parts.join("  "), status: "summary" });
  }
  return rows;
}

/** Build a compact checklist widget. */
function buildWidgetLines(
  theme: Theme,
  width: number,
  sessionId: string,
  terminalRows?: number
): string[] {
  const todos = getTodos(sessionId);

  if (todos.length === 0 || width <= 0) return [];

  if (width < 9) {
    const summary = todos
      .map(
        (todo) =>
          `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "□"} ${toSafeDisplayText(todo.content)}`
      )
      .join(" ");
    return [truncateToWidth(summary, width, "")];
  }

  const titleText = "todos";
  const contentRows = buildContentRows(todos, contentRowBudget(terminalRows));
  const maxItemWidth = contentRows.reduce((max, row) => {
    return Math.max(max, visibleWidth(row.text) + 2);
  }, visibleWidth(titleText));

  const panelWidth = Math.min(
    width,
    Math.max(8, Math.min(maxItemWidth + 4, 72))
  );
  const innerWidth = panelWidth - 4;
  const title = theme.fg("muted", titleText);
  const topPrefix = "╭─ ";
  const topSuffixWidth = Math.max(
    0,
    panelWidth - visibleWidth(topPrefix + titleText) - 1
  );
  const top =
    theme.fg("borderMuted", topPrefix) +
    title +
    theme.fg("borderMuted", "─".repeat(topSuffixWidth) + "╮");
  const bottom = theme.fg(
    "borderMuted",
    "╰" + "─".repeat(panelWidth - 2) + "╯"
  );

  const lines: string[] = [top];
  for (const row of contentRows) {
    let marker: string;
    let text: string;

    if (row.status === "in_progress") {
      marker = theme.fg("accent", "→");
      text = theme.fg("text", row.text);
    } else if (row.status === "summary") {
      marker = theme.fg("dim", "·");
      text = theme.fg("dim", row.text);
    } else {
      marker = theme.fg("dim", "□");
      text = theme.fg("muted", row.text);
    }

    const content = truncateToWidth(marker + " " + text, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
    lines.push(
      theme.fg("borderMuted", "│ ") +
        content +
        padding +
        theme.fg("borderMuted", " │")
    );
  }

  lines.push(bottom);
  return lines.map((line) => truncateToWidth(line, width, ""));
}

/** Clear the persistent todo widget. */
export function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("todowrite", undefined);
}

/** Refresh the persistent widget to match current todo state. */
export function refreshWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") {
    clearWidget(ctx);
    return;
  }

  const sessionId = ctx.sessionManager.getSessionId();

  if (!hasVisibleTodos(sessionId) || !isWidgetVisible(sessionId)) {
    clearWidget(ctx);
    return;
  }

  ctx.ui.setWidget("todowrite", (tui, theme) => ({
    render(width: number): string[] {
      const terminalRows =
        typeof (tui as { terminal?: { rows?: unknown } })?.terminal?.rows ===
        "number"
          ? (tui as { terminal: { rows: number } }).terminal.rows
          : undefined;
      return buildWidgetLines(theme, width, sessionId, terminalRows);
    },
    invalidate(): void {},
  }));
}

/** Toggle the todo widget from a keyboard shortcut and notify the user. */
export function toggleWidget(ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const visible = toggleWidgetVisible(sessionId);
  refreshWidget(ctx);

  if (!ctx.hasUI) return;
  if (visible && !hasVisibleTodos(sessionId)) {
    ctx.ui.notify(
      "Todo widget enabled, but there are no active todos.",
      "info"
    );
    return;
  }
  ctx.ui.notify(visible ? "Todo widget shown." : "Todo widget hidden.", "info");
}
