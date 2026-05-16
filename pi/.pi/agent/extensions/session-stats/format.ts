import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionStats } from "./types.js";

/** Format large counts using compact suffixes. */
export function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toLocaleString("en-US");
}

/** Format a percentage with compact precision. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return value.toFixed(value >= 10 || value === 0 ? 0 : 1) + "%";
}

/** Calculate read cache hit rate as a percentage. */
export function readCacheHitRate(input: number, cacheRead: number): number {
  const promptTokens = input + cacheRead;
  return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : 0;
}

/** Format USD cost with useful precision for small values. */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "$0";
  if (usd < 0.01) return "$" + usd.toFixed(4);
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
export function color(theme: any, token: string, text: string): string {
  return theme?.fg ? theme.fg(token, text) : text;
}

/** Apply bold styling when a theme is available. */
export function bold(theme: any, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

/** Pad a possibly styled string to a visible width. */
export function padRightVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Build a simple horizontal progress bar. */
export function progressBar(value: number, max: number, width: number, theme?: any): string {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const filled = Math.round(ratio * width);
  return color(theme, "accent", "█".repeat(filled)) + color(theme, "dim", "░".repeat(Math.max(0, width - filled)));
}

/** Format cache hit rate with a bar. */
export function formatCacheHit(input: number, cacheRead: number, theme?: any): string {
  const hitRate = readCacheHitRate(input, cacheRead);
  return formatPercent(hitRate).padStart(5) + " " + progressBar(hitRate, 100, 10, theme);
}

/** Finalize total token count from component counters and reported provider totals. */
export function finalizeTotalTokens(stats: Pick<SessionStats, "totalTokens">, fallbackTotalTokens = 0): void {
  const computedTotal = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.cacheRead;
  stats.totalTokens.totalTokens = Math.max(computedTotal, fallbackTotalTokens);
}
