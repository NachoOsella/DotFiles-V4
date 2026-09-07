import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Pure dashboard layout helpers (P11).
// Every function here is synchronous, deterministic, and performs no
// filesystem/process work, so footer/header rendering stays cheap and safe
// to call on every repaint. Inputs are treated as opaque text: helpers
// measure visible width (ANSI-aware) but never parse semantic state out of
// colored strings.

export const LEGACY_HEADER_LINE_COUNT = 13;

// Proposed compact-header threshold (NOT wired as the default: without
// approval the header keeps its existing logo behavior; see buildHeaderLines
// and the note in index.ts). Small terminals fall back to a single line.
export const COMPACT_HEADER_MIN_HEIGHT = 24;

export function normalizeWidth(width: unknown, fallback = 80): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return fallback;
  return Math.max(1, Math.floor(width));
}

export function normalizeHeight(height: unknown): number | null {
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.max(1, Math.floor(height));
}

// Legacy policy: the logo shows unless explicitly disabled. The compact
// proposal additionally hides it on short terminals; pass
// logoEnabled=false or a small height to preview that policy.
export function shouldShowLogo(
  height: number | null,
  logoEnabled: boolean,
): boolean {
  if (!logoEnabled) return false;
  if (height !== null && height < COMPACT_HEADER_MIN_HEIGHT) return false;
  return true;
}

export interface HeaderPlanInput {
  width: number;
  height: number | null;
  title: string;
  logoLines: readonly string[];
  // Default true preserves the existing header. False previews the proposed
  // compact policy (single line on small terminals / when disabled).
  logoEnabled?: boolean;
}

// Plain-text header layout. The caller applies theme styling; centering and
// truncation are width-driven so widths 1-160 and small heights are safe.
//
// Approval note (P11 step 3): without approval the legacy default is kept -
// the logo always renders (height-agnostic) unless logoEnabled === false.
// Height-aware auto-compact on small terminals is implemented as
// shouldShowLogo/buildHeaderLines(logoEnabled=false) and covered by tests,
// but it is NOT wired as the default. See the proposal comment in index.ts.
export function buildHeaderLines(input: HeaderPlanInput): string[] {
  const width = normalizeWidth(input.width);
  normalizeHeight(input.height);
  const logoEnabled = input.logoEnabled ?? true;
  if (!logoEnabled) {
    return [truncateToWidth(input.title, width)];
  }
  const center = (text: string) => {
    const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
    return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
  };
  return [
    "",
    ...input.logoLines.map((line) => center(line)),
    center(input.title),
    "",
  ];
}

// Existing two-column footer layout with a bounded 45/55 fallback split.
// Pure: no filesystem/process access; safe for widths down to 1.
export function columns(left: string, right: string, width: number): string {
  const safeWidth = normalizeWidth(width);
  if (!right) return truncateToWidth(left, safeWidth);

  const naturalGap = safeWidth - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(safeWidth * 0.45));
  const rightWidth = Math.max(1, safeWidth - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    safeWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    safeWidth,
  );
}

export function formatModelLabel(
  provider: string,
  modelId: string,
  thinking: string,
): string {
  // Legacy shape: without a provider the footer shows the bare model id.
  if (!provider) return modelId;
  const base = `${provider}/${modelId}`;
  return thinking ? `${base} · ${thinking}` : base;
}

export function formatModelLabelWithoutProvider(
  modelId: string,
  thinking: string,
): string {
  return thinking ? `${modelId} · ${thinking}` : modelId;
}

// Live streaming estimates carry a `~` prefix; measured final cadences do
// not. Null/unknown throughput renders as an em-dash placeholder.
export function formatThroughput(
  tokensPerSecond: number | null,
  isEstimate: boolean,
): string {
  if (
    tokensPerSecond === null ||
    typeof tokensPerSecond !== "number" ||
    !Number.isFinite(tokensPerSecond)
  ) {
    return "— tok/s";
  }
  const rounded = Math.round(tokensPerSecond);
  return isEstimate ? `~${rounded} tok/s` : `${rounded} tok/s`;
}

export function formatTokens(tokens: number): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "?";
  if (tokens < 1_000) return `${Math.floor(tokens)}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export interface UsageLabelInput {
  contextPercent: number | null;
  contextWindow: number;
  cost: number;
  throughput: string;
  includeThroughput?: boolean;
}

export function formatUsageLabel(input: UsageLabelInput): string {
  const percent =
    input.contextPercent === null ||
    typeof input.contextPercent !== "number" ||
    !Number.isFinite(input.contextPercent)
      ? "?"
      : `${Math.round(input.contextPercent)}`;
  const window =
    typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? formatTokens(input.contextWindow)
      : "?";
  const cost =
    typeof input.cost === "number" && Number.isFinite(input.cost)
      ? input.cost
      : 0;
  const base = `${percent}%/${window} · $${cost.toFixed(2)}`;
  return input.includeThroughput === false
    ? base
    : `${base} · ${input.throughput}`;
}

export interface GitLabelInput {
  branch: string | null;
  changedFiles: number;
  pullRequestNumber: number | null;
  includePullRequest?: boolean;
  stale?: boolean;
}

export function formatGitLabel(input: GitLabelInput): string {
  if (!input.branch) return "";
  const files =
    typeof input.changedFiles === "number" &&
    Number.isFinite(input.changedFiles)
      ? Math.max(0, Math.floor(input.changedFiles))
      : 0;
  const fileLabel = files === 1 ? "file" : "files";
  let label = `${input.branch} · ${files} ${fileLabel} changed`;
  if (input.includePullRequest !== false && input.pullRequestNumber !== null) {
    label += ` · PR #${input.pullRequestNumber}`;
  }
  if (input.stale === true) label += " (stale)";
  return label;
}

export interface FooterFitInput {
  width: number;
  directory: string;
  provider: string;
  modelId: string;
  thinking: string;
  contextPercent: number | null;
  contextWindow: number;
  cost: number;
  tokensPerSecond: number | null;
  throughputIsEstimate: boolean;
  branch: string | null;
  changedFiles: number;
  pullRequestNumber: number | null;
  gitStale?: boolean;
}

export interface FooterFitOutput {
  row1Left: string;
  row1Right: string;
  row2Left: string;
  row2Right: string;
  // Degradation steps applied, in order. Optional segments are dropped before
  // critical state is ever truncated: PR label, throughput, provider prefix,
  // then long path segments.
  dropped: string[];
}

function rowsFit(
  row1Left: string,
  row1Right: string,
  row2Left: string,
  row2Right: string,
  width: number,
): boolean {
  return (
    visibleWidth(row1Left) + (row1Right ? visibleWidth(row1Right) + 1 : 0) <=
      width &&
    visibleWidth(row2Left) + (row2Right ? visibleWidth(row2Right) + 1 : 0) <=
      width
  );
}

function basenameSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return path;
  const last = parts[parts.length - 1]!;
  return path.startsWith("~") ? `…/${last}` : `…/${last}`;
}

// Priority degradation for the two primary footer rows. Returns exactly two
// rows worth of segments (unthemed); the caller themes them and lays them
// out with columns(), which truncates only as a last resort.
export function fitFooterSegments(input: FooterFitInput): FooterFitOutput {
  const width = normalizeWidth(input.width);
  const dropped: string[] = [];
  let includePr = true;
  let includeThroughput = true;
  let includeProvider = true;
  let directory = input.directory;

  const build = () => {
    const throughput = formatThroughput(
      input.tokensPerSecond,
      input.throughputIsEstimate,
    );
    const model = includeProvider
      ? formatModelLabel(input.provider, input.modelId, input.thinking)
      : formatModelLabelWithoutProvider(input.modelId, input.thinking);
    const usage = formatUsageLabel({
      contextPercent: input.contextPercent,
      contextWindow: input.contextWindow,
      cost: input.cost,
      throughput,
      includeThroughput,
    });
    const git = formatGitLabel({
      branch: input.branch,
      changedFiles: input.changedFiles,
      pullRequestNumber: input.pullRequestNumber,
      includePullRequest: includePr,
      stale: input.gitStale,
    });
    return { model, usage, git };
  };

  let current = build();
  if (rowsFit(directory, current.model, current.usage, current.git, width)) {
    return {
      row1Left: directory,
      row1Right: current.model,
      row2Left: current.usage,
      row2Right: current.git,
      dropped,
    };
  }

  // 1. Drop the PR label (recoverable via /pr and the git extension).
  includePr = false;
  dropped.push("pr");
  current = build();
  if (rowsFit(directory, current.model, current.usage, current.git, width)) {
    return {
      row1Left: directory,
      row1Right: current.model,
      row2Left: current.usage,
      row2Right: current.git,
      dropped,
    };
  }

  // 2. Drop live throughput (context % and cost are more critical).
  includeThroughput = false;
  dropped.push("throughput");
  current = build();
  if (rowsFit(directory, current.model, current.usage, current.git, width)) {
    return {
      row1Left: directory,
      row1Right: current.model,
      row2Left: current.usage,
      row2Right: current.git,
      dropped,
    };
  }

  // 3. Drop the provider prefix (model id + thinking remain).
  includeProvider = false;
  dropped.push("provider-prefix");
  current = build();
  if (rowsFit(directory, current.model, current.usage, current.git, width)) {
    return {
      row1Left: directory,
      row1Right: current.model,
      row2Left: current.usage,
      row2Right: current.git,
      dropped,
    };
  }

  // 4. Shorten long paths to their final segment before truncating state.
  if (directory.length > 1) {
    directory = basenameSegment(directory);
    dropped.push("path");
    current = build();
  }

  return {
    row1Left: directory,
    row1Right: current.model,
    row2Left: current.usage,
    row2Right: current.git,
    dropped,
  };
}

export interface PackedStatuses {
  // Packed single-line rows, each already truncated to width.
  lines: string[];
  // Statuses that did not fit; the caller must surface this count (e.g.
  // "+N more") rather than silently deleting them.
  overflow: number;
}

// Pack short extension statuses into at most maxLines rows. Statuses are
// opaque text: they are measured (ANSI-aware) and joined, never parsed for
// semantic state. Every input is either shown or counted in overflow.
export function packExtensionStatuses(
  statusLines: string[],
  width: number,
  maxLines = 1,
): PackedStatuses {
  const safeWidth = normalizeWidth(width);
  const safeMax = Math.max(1, Math.floor(maxLines) || 1);
  const lines = statusLines.filter((line) => line.length > 0);
  if (lines.length === 0) return { lines: [], overflow: 0 };

  const packed: string[] = [];
  let current = "";
  let consumed = 0;
  let stopped = false;
  for (const line of lines) {
    const candidate = current ? `${current} · ${line}` : line;
    if (current !== "" && visibleWidth(candidate) > safeWidth) {
      packed.push(truncateToWidth(current, safeWidth));
      if (packed.length >= safeMax) {
        stopped = true;
        break;
      }
      current = line;
      consumed += 1;
      continue;
    }
    current = candidate;
    consumed += 1;
  }
  if (!stopped && current) {
    packed.push(truncateToWidth(current, safeWidth));
  }
  return { lines: packed, overflow: Math.max(0, lines.length - consumed) };
}

// Append an overflow indicator without silently deleting statuses. Returns
// the packed line plus a short overflow row when needed.
export function appendOverflowIndicator(
  packedLine: string,
  overflow: number,
  width: number,
): string {
  const safeWidth = normalizeWidth(width);
  if (overflow <= 0) return truncateToWidth(packedLine, safeWidth);
  const indicator = `+${overflow} more`;
  if (!packedLine) return truncateToWidth(indicator, safeWidth);
  const candidate = `${packedLine} · ${indicator}`;
  if (visibleWidth(candidate) <= safeWidth) return candidate;
  // Indicator wins over tail content: critical count info is preserved.
  const room = Math.max(0, safeWidth - visibleWidth(indicator) - 3);
  return `${truncateToWidth(packedLine, room)} · ${indicator}`;
}
