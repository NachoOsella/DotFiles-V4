import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  getTodos,
  hasVisibleTodos,
  isWidgetVisible,
  toggleWidgetVisible,
} from "./state.ts";

/** Build a compact checklist widget. */
function buildWidgetLines(
  theme: Theme,
  width: number,
  sessionId: string
): string[] {
  const todos = getTodos(sessionId);

  if (todos.length === 0 || width <= 0) return [];

  if (width < 9) {
    const summary = todos
      .map(
        (todo) =>
          `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "□"} ${todo.content}`
      )
      .join(" ");
    return [truncateToWidth(summary, width, "")];
  }

  const titleText = "todos";
  const maxItemWidth = todos.reduce((max, todo) => {
    return Math.max(max, visibleWidth(todo.content) + 2);
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

  ctx.ui.setWidget("todowrite", (_tui, theme) => ({
    render(width: number): string[] {
      return buildWidgetLines(theme, width, sessionId);
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
