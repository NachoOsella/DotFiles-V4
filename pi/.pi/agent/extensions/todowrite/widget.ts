import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getTodos, hasVisibleTodos, isWidgetVisible, toggleWidgetVisible } from "./state.js";

/** Return true when the widget should currently be rendered. */
function shouldShowWidget(): boolean {
  return isWidgetVisible() && hasVisibleTodos();
}

/** Build a compact Codex-style checklist widget. */
function buildWidgetLines(theme: Theme, width: number): string[] {
  if (!shouldShowWidget()) return [];

  const todos = getTodos();
  const titleText = "todos";
  const maxItemWidth = todos.reduce((max, todo) => {
    return Math.max(max, visibleWidth(todo.content) + 2);
  }, visibleWidth(titleText));

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

/** Clear the persistent todo widget. */
export function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("todowrite", undefined);
}

/** Refresh the persistent widget to match current todo state. */
export function refreshWidget(ctx: ExtensionContext): void {
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

/** Toggle the todo widget from a keyboard shortcut and notify the user. */
export function toggleWidget(ctx: ExtensionContext): void {
  const visible = toggleWidgetVisible();
  refreshWidget(ctx);

  if (!ctx.hasUI) return;
  if (visible && !hasVisibleTodos()) {
    ctx.ui.notify("Todo widget enabled, but there are no active todos.", "info");
    return;
  }
  ctx.ui.notify(visible ? "Todo widget shown." : "Todo widget hidden.", "info");
}
