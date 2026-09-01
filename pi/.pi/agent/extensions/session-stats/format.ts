import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionStats } from "./types.ts";

/** Format large counts using compact suffixes. */
export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return compactNumber(num / 1_000_000_000) + "B";
  if (num >= 1_000_000) return compactNumber(num / 1_000_000) + "M";
  if (num >= 1_000) return compactNumber(num / 1_000) + "K";
  return num.toLocaleString("en-US");
}

function compactNumber(value: number): string {
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}

/** Format a percentage with compact precision. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return value.toFixed(value >= 10 || value === 0 ? 0 : 1) + "%";
}

/** Calculate the share of prompt tokens served from the read cache. */
export function calculateCacheReadShare(
  input: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
}

/** Format USD cost with useful precision for small values. */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return "<$0.000001";
  if (usd < 0.01) return "$" + usd.toFixed(6);
  return "$" + usd.toFixed(2);
}

/** Format elapsed time in a compact human-readable form. */
export function fmtDuration(ms: number): string {
  if (ms < 0) return "--";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return minutes + "m " + remSeconds + "s";
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return hours + "h " + remMinutes + "m";
}

/** Truncate text to a terminal display width. */
export function fitToWidth(text: string, width: number): string {
  return truncateToWidth(text, width, "", true);
}

/** Apply a theme foreground token when a theme is available. */
export function color(
  theme: Theme | undefined,
  token: Parameters<Theme["fg"]>[0],
  text: string,
): string {
  return theme ? theme.fg(token, text) : text;
}

/** Apply bold styling when a theme is available. */
export function bold(theme: Theme | undefined, text: string): string {
  return theme ? theme.bold(text) : text;
}

/** Pad a possibly styled string to a visible width. */
export function padRightVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Build a simple horizontal progress bar. */
export function progressBar(
  value: number,
  max: number,
  width: number,
  theme?: Theme,
  fillToken: Parameters<Theme["fg"]>[0] = "accent",
): string {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const filled = Math.round(ratio * width);
  return (
    color(theme, fillToken, "█".repeat(filled)) +
    color(theme, "dim", "░".repeat(Math.max(0, width - filled)))
  );
}

/** Format cache read share with a compact bar. */
export function formatCacheReadShare(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  theme?: Theme,
): string {
  const share = calculateCacheReadShare(input, cacheRead, cacheWrite);
  return (
    formatPercent(share).padStart(5) +
    " " +
    progressBar(share, 100, 10, theme, "success")
  );
}

/**
 * Finalize canonical usage from the explicit token buckets.
 * Provider totals are diagnostic only because they can use a different billing
 * definition and must not silently inflate the visible accumulated usage.
 */
export function finalizeTotalTokens(
  stats: Pick<SessionStats, "totalTokens">,
  reportedTotalTokens?: number,
): void {
  const computedTotal =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.cacheRead +
    stats.totalTokens.cacheWrite;
  stats.totalTokens.totalTokens = computedTotal;
  if (reportedTotalTokens !== undefined) {
    stats.totalTokens.reportedTotalTokens = reportedTotalTokens;
    stats.totalTokens.reportedTotalTokensMismatch =
      reportedTotalTokens - computedTotal;
  }
}
