import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { color, fmtCost, formatNumber, formatPercent, padRightVisible } from "./format.ts";
import type { AggregatedModelUsage, ToolUsage } from "./types.ts";

const MAX_VISIBLE_TOOLS = 5;
const MAX_VISIBLE_MODELS = 3;

/** Render only the highest-volume tools and collapse the long tail. */
export function buildToolRows(
  tools: readonly ToolUsage[],
  contentWidth: number,
  theme?: Theme,
): string[] {
  const compact = compactToolUsage(tools, MAX_VISIBLE_TOOLS);
  if (compact.length === 0) return [color(theme, "dim", "No tool calls")];

  const total = Math.max(1, tools.reduce((sum, tool) => sum + tool.count, 0));
  const maxCount = Math.max(1, compact[0]?.count ?? 1);
  const nameWidth = Math.max(10, Math.min(18, Math.floor(contentWidth * 0.34)));
  const countWidth = 6;
  const percentWidth = 5;
  const barWidth = Math.max(6, contentWidth - nameWidth - countWidth - percentWidth - 4);

  return compact.map((tool) => {
    const name = padRightVisible(truncateToWidth(tool.name, nameWidth, "…", false), nameWidth);
    const filled = Math.max(1, Math.round((tool.count / maxCount) * barWidth));
    const bar =
      color(theme, tool.name === "Other" ? "muted" : "accent", "█".repeat(filled)) +
      color(theme, "dim", "░".repeat(Math.max(0, barWidth - filled)));
    const count = formatNumber(tool.count).padStart(countWidth);
    const percent = formatPercent((tool.count / total) * 100).padStart(percentWidth);
    return `${color(theme, tool.name === "Other" ? "muted" : "text", name)} ${bar} ${color(theme, tool.name === "Other" ? "muted" : "accent", count)} ${color(theme, "dim", percent)}`;
  });
}

/** Render model usage as a compact aligned table instead of repeated cards. */
export function buildModelRows(
  models: readonly AggregatedModelUsage[],
  contentWidth: number,
  theme?: Theme,
): string[] {
  if (models.length === 0) return [color(theme, "dim", "No model usage")];

  const visible = models.slice(0, MAX_VISIBLE_MODELS);
  const messageWidth = 5;
  const tokenWidth = 8;
  const costWidth = 8;
  const nameWidth = Math.max(12, contentWidth - messageWidth - tokenWidth - costWidth - 3);
  const header =
    padRightVisible("MODEL", nameWidth) +
    " " + "MSG".padStart(messageWidth) +
    " " + "TOKENS".padStart(tokenWidth) +
    " " + "COST".padStart(costWidth);

  const rows = [color(theme, "dim", header)];
  for (const model of visible) {
    const modelName = truncateToWidth(`${model.provider}/${model.modelId}`, nameWidth, "…", false);
    const tokens = model.input + model.output + model.cacheRead;
    rows.push(
      color(theme, "text", padRightVisible(modelName, nameWidth)) +
        " " + color(theme, "muted", formatNumber(model.messages).padStart(messageWidth)) +
        " " + color(theme, "accent", formatNumber(tokens).padStart(tokenWidth)) +
        " " + color(theme, model.cost > 0 ? "warning" : "muted", fmtCost(model.cost).padStart(costWidth)),
    );
  }

  const hidden = models.length - visible.length;
  if (hidden > 0) {
    rows.push(color(theme, "dim", `+ ${hidden} more model${hidden === 1 ? "" : "s"}`));
  }
  return rows.map((row) => truncateToWidth(row, contentWidth, "…", false));
}

/** Keep the dominant tools visible and combine everything else into one row. */
export function compactToolUsage(
  tools: readonly ToolUsage[],
  limit = MAX_VISIBLE_TOOLS,
): ToolUsage[] {
  const sorted = [...tools].sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
  if (sorted.length <= limit) return sorted;

  const visibleCount = Math.max(1, limit - 1);
  const visible = sorted.slice(0, visibleCount);
  const otherCount = sorted.slice(visibleCount).reduce((sum, tool) => sum + tool.count, 0);
  return [...visible, { name: "Other", count: otherCount }];
}
