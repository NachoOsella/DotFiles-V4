import { truncateToWidth } from "@earendil-works/pi-tui";
import { mkBox } from "./box.js";
import { bold, color, fmtCost, formatCacheHit, formatNumber, fitToWidth } from "./format.js";
import type { AggregatedModelUsage, ToolUsage } from "./types.js";

/** Render a tool-usage panel. */
export function buildToolBox(tools: ToolUsage[], width: number, theme?: any): string {
  if (tools.length === 0) return "";
  const box = mkBox(width, theme);
  const total = Math.max(1, tools.reduce((sum, tool) => sum + tool.count, 0));
  const maxCount = Math.max(1, tools[0].count);
  const barMax = Math.min(20, Math.max(8, width - 36));
  const maxNameLen = Math.min(18, Math.max(8, width - 38));

  const lines: string[] = [box.hline(), box.sectionCentered("TOOL USAGE"), box.divider()];
  for (const tool of tools) {
    const barLen = Math.max(1, Math.round((tool.count / maxCount) * barMax));
    const bar = color(theme, "accent", "█".repeat(barLen)) + color(theme, "dim", "░".repeat(Math.max(0, barMax - barLen)));
    const pct = ((tool.count / total) * 100).toFixed(0) + "%";
    const name = fitToWidth(tool.name, maxNameLen);
    const countStr = truncateToWidth(formatNumber(tool.count), 7, "", false).padStart(7);
    const pctStr = pct.padStart(4);
    const row = " " + color(theme, "text", name) + " " + bar + " " + color(theme, "text", countStr) + color(theme, "dim", " (" + pctStr + ")");
    lines.push(box.content(row));
  }
  lines.push(box.hlineEnd());
  return lines.join("\n");
}

/** Render a model-usage panel. */
export function buildModelBox(models: AggregatedModelUsage[], width: number, theme?: any): string {
  if (models.length === 0) return "";
  const box = mkBox(width, theme);
  const lines: string[] = [box.hline(), box.sectionCentered("MODEL USAGE"), box.divider()];

  models.forEach((model, index) => {
    const key = model.provider + "/" + model.modelId;
    lines.push(box.content(" " + color(theme, "toolTitle", bold(theme, key))));
    lines.push(box.row("Messages", formatNumber(model.messages)));
    lines.push(box.row("Input", formatNumber(model.input)));
    lines.push(box.row("Output", formatNumber(model.output)));
    lines.push(box.row("Cache Read", formatNumber(model.cacheRead)));
    lines.push(box.row("Read Cache Hit", formatCacheHit(model.input, model.cacheRead, theme)));
    lines.push(box.row("Cost", fmtCost(model.cost)));
    if (index < models.length - 1) {
      lines.push(box.divider());
    }
  });

  lines.push(box.hlineEnd());
  return lines.join("\n");
}
