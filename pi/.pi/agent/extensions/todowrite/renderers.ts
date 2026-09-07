import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Todo, TodoDetails } from "./types.ts";

/**
 * Normalize model-authored text for themed display.
 * Control characters and line breaks would corrupt row layout and width
 * measurement, so strip them here. Stored state keeps the original text.
 */
export function toSafeDisplayText(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\t/g, " ");
}

/** Render the compact todowrite call header. */
export function renderTodoCall(args: { todos?: Todo[] }, theme: Theme): Text {
  const count = (args.todos ?? []).length;
  return new Text(
    theme.fg("toolTitle", "todowrite ") + theme.fg("muted", String(count)),
    0,
    0
  );
}

/** Render todowrite result details in collapsed or expanded form. */
export function renderTodoResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: { isError: boolean }
): Text {
  if (context.isError) {
    const errorText =
      result.content.find(
        (block) => block.type === "text" && typeof block.text === "string"
      )?.text ?? "Error";
    return new Text(theme.fg("error", errorText), 0, 0);
  }

  if (isPartial)
    return new Text(theme.fg("warning", "Updating todo list..."), 0, 0);

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
  const currentItem =
    details.currentId !== undefined && details.currentId !== null
      ? details.items.find((item) => item.id === details.currentId)
      : details.items.find((item) => item.status === "in_progress");
  const currentText =
    currentItem !== undefined
      ? `[${toSafeDisplayText(currentItem.id)}] ${toSafeDisplayText(currentItem.content)}`
      : details.current !== null
        ? toSafeDisplayText(details.current)
        : null;
  if (currentText !== null) {
    parts.push(theme.fg("accent", ">") + theme.fg("text", " " + currentText));
  }
  parts.push(theme.fg("dim", `${details.completed}/${details.total} done`));
  return parts;
}

/** Render one expanded todo item line. */
function renderExpandedItem(item: Todo, theme: Theme): string {
  const label = `[${toSafeDisplayText(item.id)}] ${toSafeDisplayText(item.content)}`;
  if (item.status === "in_progress") {
    return theme.fg("accent", "  > ") + theme.fg("text", label);
  }
  if (item.status === "completed") {
    return (
      theme.fg("success", "  [✓] ") +
      theme.fg("dim", theme.strikethrough(label))
    );
  }
  return theme.fg("dim", "  [ ] ") + theme.fg("dim", label);
}
