import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bold, color, padRightVisible } from "./format.ts";

/** Width-safe primitives for one cohesive rounded dashboard. */
export function createDashboardFrame(outerWidth: number, theme?: Theme) {
  const width = Math.max(32, outerWidth);
  const innerWidth = width - 2;
  const border = (text: string) => color(theme, "border", text);
  const mutedBorder = (text: string) => color(theme, "borderMuted", text);

  const fit = (text: string, available = innerWidth - 2) =>
    truncateToWidth(text, Math.max(0, available), "…", false);

  const row = (content = "") => {
    const fitted = fit(content);
    return border("│") + " " + padRightVisible(fitted, innerWidth - 2) + " " + border("│");
  };

  return {
    width,
    innerWidth,
    top(title: string, scope: string): string {
      const left = color(theme, "accent", bold(theme, `◆ ${title}`));
      const right = color(theme, "muted", scope);
      const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right) - 2);
      return [
        color(theme, "borderAccent", `╭${"━".repeat(innerWidth)}╮`),
        border("│") + " " + padRightVisible(`${left}${" ".repeat(gap)}${right}`, innerWidth - 2) + " " + border("│"),
      ].join("\n");
    },
    section(title: string): string {
      const label = color(theme, "accent", bold(theme, ` ${title.toUpperCase()} `));
      const remainder = Math.max(0, innerWidth - visibleWidth(label) - 1);
      return mutedBorder("├─") + label + mutedBorder(`${"─".repeat(remainder)}┤`);
    },
    row,
    blank(): string {
      return row();
    },
    metric(label: string, value: string): string {
      const styledLabel = color(theme, "muted", label);
      const styledValue = color(theme, "text", bold(theme, value));
      const gap = Math.max(1, innerWidth - visibleWidth(label) - visibleWidth(value) - 2);
      return row(`${styledLabel}${" ".repeat(gap)}${styledValue}`);
    },
    metricPair(
      leftLabel: string,
      leftValue: string,
      rightLabel: string,
      rightValue: string,
    ): string {
      const columnWidth = Math.floor((innerWidth - 5) / 2);
      const cell = (label: string, value: string) => {
        const cleanLabel = fit(label, Math.max(6, columnWidth - 4));
        const cleanValue = fit(value, Math.max(4, columnWidth - visibleWidth(cleanLabel) - 1));
        const gap = Math.max(1, columnWidth - visibleWidth(cleanLabel) - visibleWidth(cleanValue));
        return color(theme, "muted", cleanLabel) + " ".repeat(gap) + color(theme, "text", bold(theme, cleanValue));
      };
      return row(
        `${cell(leftLabel, leftValue)} ${color(theme, "borderMuted", "│")} ${cell(rightLabel, rightValue)}`,
      );
    },
    footer(hint: string): string {
      return [
        mutedBorder(`├${"─".repeat(innerWidth)}┤`),
        row(color(theme, "dim", hint)),
        color(theme, "borderAccent", `╰${"━".repeat(innerWidth)}╯`),
      ].join("\n");
    },
  };
}
