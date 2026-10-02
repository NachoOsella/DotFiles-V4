export const MODEL_INFO_CHANNEL = "dashboard:model-info";
export const GIT_INFO_CHANNEL = "dashboard:git-info";
export const DISCORD_ACTIVITY_CHANNEL = "dashboard:discord-activity";
export const SUBAGENTS_INFO_CHANNEL = "dashboard:subagents";
export const REFRESH_CHANNEL = "dashboard:refresh";

export interface ModelInfoState {
  provider: string;
  modelId: string;
  modelName: string;
  thinking: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  cost: number;
  /** Parent-only prompt-token buckets backing the session cache share. */
  promptTokens?: PromptTokens;
  tokensPerSecond: number | null;
  generating: boolean;
  // Optional: true when tokensPerSecond is a live streaming estimate,
  // false/undefined when it is a measured final cadence. Footer renders
  // estimates with a `~` prefix. Absent means "derive from generating".
  throughputIsEstimate?: boolean;
}

export interface PromptTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface GitInfoState {
  isRepository: boolean;
  branch: string | null;
  changedFiles: number;
  pullRequest: PullRequestInfo | null;
  // Optional freshness channel (P11 follow-up, producer side not yet wired:
  // git-info preserves last-known data on transient failure but does not
  // emit these fields yet). Absent/undefined means fresh. Footer renders
  // stale snapshots with a "(stale)" suffix instead of presenting them
  // as fresh.
  stale?: boolean;
  refreshError?: string | null;
}

export interface DiscordActivityState {
  active: boolean;
}

export interface SubagentInfoState {
  running: number;
  /** Cumulative child cost, excluding the parent. */
  cost?: number;
  /** Cumulative child prompt-token buckets, excluding the parent. */
  promptTokens?: PromptTokens;
  /** Plain current snapshot; consumers validate it before use. */
  snapshot?: unknown;
}

export function emptyModelInfoState(): ModelInfoState {
  return {
    provider: "",
    modelId: "no-model",
    modelName: "No model",
    thinking: "off",
    contextTokens: null,
    contextWindow: 0,
    contextPercent: null,
    cost: 0,
    promptTokens: { input: 0, cacheRead: 0, cacheWrite: 0 },
    tokensPerSecond: null,
    generating: false,
  };
}

export function emptyGitInfoState(): GitInfoState {
  return {
    isRepository: false,
    branch: null,
    changedFiles: 0,
    pullRequest: null,
  };
}

export function emptySubagentInfoState(): SubagentInfoState {
  return { running: 0 };
}

function isPromptTokens(value: unknown): value is PromptTokens {
  return (
    isRecord(value) &&
    typeof value.input === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number"
  );
}

export function sanitizePromptTokens(
  value: PromptTokens | undefined,
): PromptTokens {
  return {
    input: Math.max(0, finiteOr(value?.input, 0)),
    cacheRead: Math.max(0, finiteOr(value?.cacheRead, 0)),
    cacheWrite: Math.max(0, finiteOr(value?.cacheWrite, 0)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableNumber(value: unknown) {
  return value === null || typeof value === "number";
}

export function isDiscordActivityState(
  value: unknown,
): value is DiscordActivityState {
  return isRecord(value) && typeof value.active === "boolean";
}

export function isSubagentInfoState(
  value: unknown,
): value is SubagentInfoState {
  return (
    isRecord(value) &&
    typeof value.running === "number" &&
    (value.cost === undefined || typeof value.cost === "number") &&
    (value.promptTokens === undefined || isPromptTokens(value.promptTokens))
  );
}

export function isModelInfoState(value: unknown): value is ModelInfoState {
  if (!isRecord(value)) return false;

  return (
    typeof value.provider === "string" &&
    typeof value.modelId === "string" &&
    typeof value.modelName === "string" &&
    typeof value.thinking === "string" &&
    isNullableNumber(value.contextTokens) &&
    typeof value.contextWindow === "number" &&
    isNullableNumber(value.contextPercent) &&
    typeof value.cost === "number" &&
    (value.promptTokens === undefined || isPromptTokens(value.promptTokens)) &&
    isNullableNumber(value.tokensPerSecond) &&
    typeof value.generating === "boolean" &&
    (value.throughputIsEstimate === undefined ||
      typeof value.throughputIsEstimate === "boolean")
  );
}

function isPullRequestInfo(value: unknown): value is PullRequestInfo {
  if (!isRecord(value)) return false;

  return (
    typeof value.number === "number" &&
    typeof value.url === "string" &&
    typeof value.isDraft === "boolean"
  );
}

export function isGitInfoState(value: unknown): value is GitInfoState {
  if (!isRecord(value)) return false;

  return (
    typeof value.isRepository === "boolean" &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.changedFiles === "number" &&
    (value.pullRequest === null || isPullRequestInfo(value.pullRequest)) &&
    (value.stale === undefined || typeof value.stale === "boolean") &&
    (value.refreshError === undefined ||
      value.refreshError === null ||
      typeof value.refreshError === "string")
  );
}

// Finite-number sanitizers for dashboard consumers (P11 step 9).
// The is*State validators above intentionally keep accepting any typeof
// "number" (including NaN/Infinity) so existing external event contracts
// remain accepted as-is. Consumers must pass received state through these
// sanitizers before storing/rendering so NaN/Infinity never reach the UI.
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOrNull(value: unknown): number | null {
  if (value === null) return null;
  return isFiniteNumber(value) ? value : null;
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function sanitizeModelInfoState(value: ModelInfoState): ModelInfoState {
  return {
    ...value,
    contextTokens: finiteOrNull(value.contextTokens),
    contextWindow: finiteOr(value.contextWindow, 0),
    contextPercent: finiteOrNull(value.contextPercent),
    cost: finiteOr(value.cost, 0),
    promptTokens: sanitizePromptTokens(value.promptTokens),
    tokensPerSecond: finiteOrNull(value.tokensPerSecond),
  };
}

export function sanitizeGitInfoState(value: GitInfoState): GitInfoState {
  const changedFiles = isFiniteNumber(value.changedFiles)
    ? Math.max(0, Math.floor(value.changedFiles))
    : 0;
  return { ...value, changedFiles };
}

export function sanitizeSubagentInfoState(
  value: SubagentInfoState,
): SubagentInfoState {
  const running = isFiniteNumber(value.running)
    ? Math.max(0, Math.floor(value.running))
    : 0;
  return {
    ...value,
    running,
    cost: Math.max(0, finiteOr(value.cost, 0)),
    promptTokens: sanitizePromptTokens(value.promptTokens),
  };
}
