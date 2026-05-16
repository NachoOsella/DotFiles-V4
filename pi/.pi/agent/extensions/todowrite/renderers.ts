import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Todo, TodoDetails } from "./types.js";

/** Render the compact todowrite call header. */
export function renderTodoCall(args: { todos?: Todo[] }, theme: Theme): Text {
  const count = (args.todos ?? []).length;
  return new Text(
    theme.fg("toolTitle", "todowrite ") + theme.fg("muted", String(count)),
    0,
    0,
  );
}

/** Render todowrite result details in collapsed or expanded form. */
export function renderTodoResult(
  result: { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown },
  { expanded }: { expanded: boolean },
  theme: Theme,
): Text {
  if (result.isError) {
    return new Text(
      theme.fg("error", result.content[0]?.type === "text" ? (result.content[0].text ?? "Error") : "Error"),
      0,
      0,
    );
  }

  const details = result.details as TodoDetails | undefined;
  if (!details || details.total === 0) {
    return new Text(theme.fg("dim", "0"), 0, 0);
  }

  const parts = buildSummaryParts(details, theme);
  if (!expanded) {
    return new Text(parts.join("  "), 0, 0);
  }

  const lines: string[] = [parts.join("  "), ""];
  for (const item of details.items) {
    lines.push(renderExpandedItem(item, theme));
  }

  return new Text(lines.join("\n"), 0, 0);
}

/** Build the collapsed one-line todo summary. */
function buildSummaryParts(details: TodoDetails, theme: Theme): string[] {
  const parts: string[] = [];
  if (details.current) {
    parts.push(theme.fg("accent", ">") + theme.fg("text", " " + details.current));
  }
  if (details.pending > 0) {
    parts.push(theme.fg("dim", "+" + details.pending));
  }
  if (details.completed > 0) {
    parts.push(theme.fg("success", "✓" + details.completed));
  }
  return parts;
}

/** Render one expanded todo item line. */
function renderExpandedItem(item: Todo, theme: Theme): string {
  if (item.status === "in_progress") {
    return theme.fg("accent", "  > ") + theme.fg("text", item.content);
  }
  if (item.status === "completed") {
    return theme.fg("success", "  [✓] ") + theme.fg("dim", theme.strikethrough(item.content));
  }
  return theme.fg("dim", "  [ ] ") + theme.fg("dim", item.content);
}
