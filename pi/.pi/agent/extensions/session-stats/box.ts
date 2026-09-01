import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bold, color, padRightVisible } from "./format.ts";

/** Width-safe primitives for one cohesive, lightly framed dashboard. */
export function createDashboardFrame(outerWidth: number, theme?: Theme) {
  const width = Math.max(2, outerWidth);
  const innerWidth = width - 2;
  const border = (text: string) => color(theme, "border", text);
  const mutedBorder = (text: string) => color(theme, "borderMuted", text);

  const fit = (text: string, available = Math.max(0, innerWidth - 2)) =>
    truncateToWidth(text, Math.max(0, available), "…", false);

  const row = (content = "") => {
    const leftPadding = innerWidth >= 1 ? " " : "";
    const rightPadding = innerWidth >= 2 ? " " : "";
    const available = Math.max(
      0,
      innerWidth - leftPadding.length - rightPadding.length,
    );
    const fitted = fit(content, available);
    return (
      border("│") +
      leftPadding +
      padRightVisible(fitted, available) +
      rightPadding +
      border("│")
    );
  };

  return {
    width,
    innerWidth,
    top(title: string, scope: string): string {
      const left = color(theme, "accent", bold(theme, title));
      const right = color(theme, "muted", scope);
      const gap = Math.max(
        1,
        innerWidth - visibleWidth(left) - visibleWidth(right) - 2,
      );
      const header = fit(`${left}${" ".repeat(gap)}${right}`);
      return [
        color(theme, "borderAccent", `╭${"─".repeat(innerWidth)}╮`),
        row(header),
      ].join("\n");
    },
    section(title: string): string {
      const label = color(
        theme,
        "accent",
        bold(theme, ` ${title.toUpperCase()} `),
      );
      const remainder = Math.max(0, innerWidth - visibleWidth(label) - 1);
      return truncateToWidth(
        mutedBorder("├─") + label + mutedBorder(`${"─".repeat(remainder)}┤`),
        width,
        "",
        false,
      );
    },
    row,
    blank(): string {
      return row();
    },
    metric(label: string, value: string, emphasize = false): string {
      const styledLabel = color(theme, "muted", label);
      const styledValue = color(
        theme,
        "text",
        emphasize ? bold(theme, value) : value,
      );
      const gap = Math.max(
        1,
        innerWidth - visibleWidth(label) - visibleWidth(value) - 2,
      );
      return row(`${styledLabel}${" ".repeat(gap)}${styledValue}`);
    },
    metricPair(
      leftLabel: string,
      leftValue: string,
      rightLabel: string,
      rightValue: string,
    ): string {
      const columnWidth = Math.max(1, Math.floor((innerWidth - 5) / 2));
      const cell = (label: string, value: string) => {
        const cleanLabel = fit(label, Math.max(1, columnWidth - 4));
        const cleanValue = fit(
          value,
          Math.max(1, columnWidth - visibleWidth(cleanLabel) - 1),
        );
        const gap = Math.max(
          1,
          columnWidth - visibleWidth(cleanLabel) - visibleWidth(cleanValue),
        );
        return (
          color(theme, "muted", cleanLabel) +
          " ".repeat(gap) +
          color(theme, "text", cleanValue)
        );
      };
      return row(
        `${cell(leftLabel, leftValue)} ${color(theme, "borderMuted", "│")} ${cell(rightLabel, rightValue)}`,
      );
    },
    footer(hint: string): string {
      return [
        truncateToWidth(
          mutedBorder(`├${"─".repeat(innerWidth)}┤`),
          width,
          "",
          false,
        ),
        row(color(theme, "dim", hint)),
        color(theme, "borderAccent", `╰${"─".repeat(innerWidth)}╯`),
      ].join("\n");
    },
  };
}
