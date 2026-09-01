import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { combinePricingSources } from "./pricing.ts";
import {
  color,
  fmtCost,
  formatNumber,
  formatPercent,
  padRightVisible,
} from "./format.ts";
import type { AggregatedModelUsage, ToolUsage } from "./types.ts";

const MAX_VISIBLE_TOOLS = 5;
const MAX_VISIBLE_MODELS = 5;

/** Render only the highest-volume tools and collapse the long tail. */
export function buildToolRows(
  tools: readonly ToolUsage[],
  contentWidth: number,
  theme?: Theme,
): string[] {
  const compact = compactToolUsage(tools, MAX_VISIBLE_TOOLS);
  if (compact.length === 0) return [color(theme, "dim", "No tool calls")];

  const total = Math.max(
    1,
    tools.reduce((sum, tool) => sum + tool.count, 0),
  );
  const maxCount = Math.max(1, compact[0]?.count ?? 1);
  const nameWidth = Math.max(10, Math.min(18, Math.floor(contentWidth * 0.34)));
  const countWidth = 6;
  const percentWidth = 5;
  const barWidth = Math.max(
    6,
    contentWidth - nameWidth - countWidth - percentWidth - 4,
  );

  return compact.map((tool) => {
    const name = padRightVisible(
      truncateToWidth(tool.name, nameWidth, "…", false),
      nameWidth,
    );
    const filled = Math.min(
      barWidth,
      Math.max(1, Math.round((tool.count / maxCount) * barWidth)),
    );
    const bar =
      color(
        theme,
        tool.name === "Other" ? "muted" : "accent",
        "█".repeat(filled),
      ) + color(theme, "dim", "░".repeat(Math.max(0, barWidth - filled)));
    const count = formatNumber(tool.count).padStart(countWidth);
    const percent = formatPercent((tool.count / total) * 100).padStart(
      percentWidth,
    );
    return truncateToWidth(
      `${color(theme, tool.name === "Other" ? "muted" : "text", name)} ${bar} ${color(theme, tool.name === "Other" ? "muted" : "accent", count)} ${color(theme, "dim", percent)}`,
      contentWidth,
      "…",
      false,
    );
  });
}

/**
 * Render model usage as an aligned table. Hidden models become an explicit
 * "Other models" row so visible token usage and known costs remain grouped.
 */
export function buildModelRows(
  models: readonly AggregatedModelUsage[],
  contentWidth: number,
  theme?: Theme,
  unattributed?: AggregatedModelUsage,
): string[] {
  const activeModels = models.filter(
    (model) => modelTokenCount(model) > 0 || model.cost > 0,
  );
  const activeUnattributed =
    unattributed && (modelTokenCount(unattributed) > 0 || unattributed.cost > 0)
      ? unattributed
      : undefined;
  if (activeModels.length === 0 && !activeUnattributed) return [];

  const visible = compactModelUsage(activeModels, MAX_VISIBLE_MODELS);
  const messageWidth = 5;
  const tokenWidth = 8;
  const costWidth = Math.max(8, Math.min(14, Math.floor(contentWidth * 0.23)));
  const allModels = activeUnattributed
    ? [...visible, activeUnattributed]
    : visible;
  const showCost = allModels.some((model) => model.cost > 0);
  const nameWidth = Math.max(
    12,
    contentWidth - messageWidth - tokenWidth - (showCost ? costWidth : 0) - 3,
  );
  const header =
    padRightVisible("MODEL", nameWidth) +
    " " +
    "RESP".padStart(messageWidth) +
    " " +
    "TOKENS".padStart(tokenWidth) +
    (showCost ? " " + "COST".padStart(costWidth) : "");

  const rows = [
    color(theme, "dim", truncateToWidth(header, contentWidth, "…", false)),
  ];
  for (const model of visible)
    rows.push(
      renderModelRow(
        model,
        nameWidth,
        messageWidth,
        tokenWidth,
        costWidth,
        contentWidth,
        theme,
        showCost,
      ),
    );
  if (activeUnattributed) {
    rows.push(
      renderModelRow(
        activeUnattributed,
        nameWidth,
        messageWidth,
        tokenWidth,
        costWidth,
        contentWidth,
        theme,
        showCost,
      ),
    );
  }
  return rows;
}

/** Keep dominant models visible and combine the remainder into one row. */
export function compactModelUsage(
  models: readonly AggregatedModelUsage[],
  limit = MAX_VISIBLE_MODELS,
): AggregatedModelUsage[] {
  const sorted = [...models].sort(
    (left, right) =>
      right.messages - left.messages ||
      modelTokenCount(right) - modelTokenCount(left) ||
      left.modelId.localeCompare(right.modelId),
  );
  if (sorted.length <= limit) return sorted;

  const visibleCount = Math.max(1, limit - 1);
  const visible = sorted.slice(0, visibleCount);
  const other = sorted
    .slice(visibleCount)
    .reduce(mergeModels, emptyModel("Other models"));
  return [...visible, other];
}

/** Keep the dominant tools visible and combine everything else into one row. */
export function compactToolUsage(
  tools: readonly ToolUsage[],
  limit = MAX_VISIBLE_TOOLS,
): ToolUsage[] {
  const sorted = [...tools].sort(
    (left, right) =>
      right.count - left.count || left.name.localeCompare(right.name),
  );
  if (sorted.length <= limit) return sorted;

  const visibleCount = Math.max(1, limit - 1);
  const visible = sorted.slice(0, visibleCount);
  const otherCount = sorted
    .slice(visibleCount)
    .reduce((sum, tool) => sum + tool.count, 0);
  return [...visible, { name: "Other", count: otherCount }];
}

function renderModelRow(
  model: AggregatedModelUsage,
  nameWidth: number,
  messageWidth: number,
  tokenWidth: number,
  costWidth: number,
  contentWidth: number,
  theme: Theme | undefined,
  showCost: boolean,
): string {
  const modelName = truncateToWidth(
    model.provider ? `${model.provider}/${model.modelId}` : model.modelId,
    nameWidth,
    "…",
    false,
  );
  const tokens = modelTokenCount(model);
  const cost = formatModelCost(model);
  const responseCount =
    model.modelId === "Tools & summaries" ? "—" : formatNumber(model.messages);
  return truncateToWidth(
    color(theme, "text", padRightVisible(modelName, nameWidth)) +
      " " +
      color(theme, "muted", responseCount.padStart(messageWidth)) +
      " " +
      color(theme, "accent", formatNumber(tokens).padStart(tokenWidth)) +
      (showCost && cost
        ? " " + color(theme, "text", cost.padStart(costWidth))
        : ""),
    contentWidth,
    "…",
    false,
  );
}

/** Keep zero, estimated, and unknown model costs out of the table. */
function formatModelCost(model: AggregatedModelUsage): string {
  return model.cost > 0 ? fmtCost(model.cost) : "";
}

function emptyModel(modelId: string): AggregatedModelUsage {
  return {
    provider: "",
    modelId,
    messages: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    reportedCost: 0,
    catalogCost: 0,
    estimatedCost: 0,
    unknownTokens: 0,
    pricedTokens: 0,
  };
}

function mergeModels(
  target: AggregatedModelUsage,
  source: AggregatedModelUsage,
): AggregatedModelUsage {
  target.messages += source.messages;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.reportedCost = (target.reportedCost ?? 0) + (source.reportedCost ?? 0);
  target.catalogCost = (target.catalogCost ?? 0) + (source.catalogCost ?? 0);
  target.estimatedCost =
    (target.estimatedCost ?? 0) + (source.estimatedCost ?? 0);
  target.unknownTokens =
    (target.unknownTokens ?? 0) + (source.unknownTokens ?? 0);
  target.pricedTokens = (target.pricedTokens ?? 0) + (source.pricedTokens ?? 0);
  target.pricingSource = combinePricingSources(
    target.pricingSource,
    source.pricingSource,
  );
  return target;
}

function modelTokenCount(
  model: Pick<
    AggregatedModelUsage,
    "input" | "output" | "cacheRead" | "cacheWrite"
  >,
): number {
  return model.input + model.output + model.cacheRead + model.cacheWrite;
}
