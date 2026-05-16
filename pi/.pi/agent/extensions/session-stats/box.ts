import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bold, color, fitToWidth, padRightVisible } from "./format.js";

const TL = "╭", TR = "╮", BL = "╰", BR = "╯";
const HL = "─", VL = "│", LX = "├", RX = "┤";

/** Create a small rounded-box renderer for width-adaptive stat panels. */
export function mkBox(width: number, theme?: any) {
  const border = (text: string) => color(theme, "border", text);
  const borderAccent = (text: string) => color(theme, "borderAccent", text);

  return {
    hline: () => borderAccent(TL + HL.repeat(width) + TR),
    hlineEnd: () => border(BL + HL.repeat(width) + BR),
    divider: () => border(LX + HL.repeat(width) + RX),
    sectionCentered: (title: string) => {
      const rawTitle = truncateToWidth(title, width - 2, "", false);
      const cleanTitle = " " + rawTitle + " ";
      const titleWidth = visibleWidth(cleanTitle);
      const leftPad = Math.floor((width - titleWidth) / 2);
      const rightPad = width - titleWidth - leftPad;
      return border(VL)
        + color(theme, "dim", " ".repeat(Math.max(0, leftPad)))
        + color(theme, "accent", bold(theme, cleanTitle))
        + color(theme, "dim", " ".repeat(Math.max(0, rightPad)))
        + border(VL);
    },
    row: (label: string, value: string) => {
      const cleanLabel = truncateToWidth(label, Math.max(1, width - 2), "", false);
      const labelWidth = visibleWidth(cleanLabel);
      const cleanValue = truncateToWidth(value, Math.max(0, width - labelWidth - 2), "", false);
      const valueWidth = visibleWidth(cleanValue);
      const gap = Math.max(1, width - labelWidth - valueWidth - 1);
      return border(VL) + color(theme, "muted", cleanLabel) + " ".repeat(gap) + color(theme, "text", cleanValue) + " " + border(VL);
    },
    content: (text: string) => border(VL) + padRightVisible(fitToWidth(text, width), width) + border(VL),
    note: (text: string) => border(VL) + color(theme, "dim", padRightVisible(fitToWidth(text, width), width)) + border(VL),
  };
}
