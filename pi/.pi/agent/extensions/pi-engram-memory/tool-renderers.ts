import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { cropPlain } from "./utils.js";

/** Build a tiny component that renders preformatted lines without wrapping. */
function compactLines(lines: string[]): Component {
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(20, width);
      return lines.map((line) => truncateToWidth(line, safeWidth));
    },
    invalidate() {},
  };
}

/** Extract the plain text payload from a tool execution result. */
function toolText(result: any): string {
  const item = result?.content?.find?.((entry: any) => entry?.type === "text");
  return typeof item?.text === "string" ? item.text.trim() : "";
}

/** Style one memory result line while keeping it compact and ANSI-safe. */
function styleMemoryLine(line: string, theme: any): string {
  const match = line.match(/^(#\d+)\s+([a-z]{4})\s+(p\d)\s+(.+)$/);
  if (!match) return theme.fg("muted", line);

  const [, id, type, priority, rest] = match;
  const [title, snippet] = rest.split(/\s+--\s+/, 2);
  let out = `${theme.fg("accent", id)} ${theme.fg("muted", type)} ${theme.fg("warning", priority)} ${title}`;
  if (snippet) out += theme.fg("dim", ` -- ${snippet}`);
  return out;
}

/** Render memory tools as clean single-line summaries and compact result lists. */
export function memoryToolRenderer(label: string) {
  return {
    renderCall(args: any, theme: any) {
      const parts: string[] = [];
      if (args?.id !== undefined) parts.push(`#${args.id}`);
      if (args?.query) parts.push(`"${cropPlain(args.query, 34)}"`);
      if (!args?.query && args?.title) parts.push(`"${cropPlain(args.title, 34)}"`);
      if (args?.type) parts.push(String(args.type));
      if (args?.priority_min) parts.push(`p>=${args.priority_min}`);
      if (args?.limit) parts.push(`n=${args.limit}`);
      const suffix = parts.length ? theme.fg("dim", ` ${parts.join(" ")}`) : "";
      return new Text(theme.fg("toolTitle", theme.bold(label)) + suffix, 0, 0);
    },

    renderResult(result: any, options: any, theme: any) {
      if (options?.isPartial) return new Text(theme.fg("warning", "working..."), 0, 0);

      const text = toolText(result);
      if (!text) return new Text(theme.fg("dim", "done"), 0, 0);

      const rawLines = text.split("\n").filter(Boolean);
      if (rawLines.length === 1 && rawLines[0] === "(no memories found)") {
        return new Text(theme.fg("dim", "no memories"), 0, 0);
      }

      const maxLines = options?.expanded ? rawLines.length : 8;
      const visible = rawLines.slice(0, maxLines).map((line) => styleMemoryLine(line, theme));
      if (rawLines.length > maxLines) {
        visible.push(theme.fg("dim", `... ${rawLines.length - maxLines} more`));
      }
      return compactLines(visible);
    },
  };
}
