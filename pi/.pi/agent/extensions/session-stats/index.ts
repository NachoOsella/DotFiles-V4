/** Session statistics command backed by bounded, fault-tolerant Effect pipelines. */

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { showStatsModal } from "./modal.ts";
import { mergeSessionStats } from "./aggregate.ts";
import {
  buildAllStatsOutput,
  buildCurrentSessionOutput,
  buildProjectStatsOutput,
  buildProjectSummaries,
} from "./output.ts";
import { parseCurrentBranch, parseSessionFileEffect } from "./parser.ts";
import type {
  ModelPricingResolver,
  SessionEntryLike,
  SessionStats,
} from "./types.ts";

const STATUS_KEY = "session-stats";
const SUBAGENT_SESSION_PREFIX = "subagent:";
const MAX_CONCURRENT_READS = 8;

/** Paid catalog equivalents used to estimate the value of free endpoints. */
const FREE_MODEL_PRICE_REFERENCES: Record<string, readonly [string, string][]> = {
  "hy3-free": [["openrouter", "tencent/hy3"]],
  "mimo-v2-pro-free": [["opencode-go", "mimo-v2.5-pro"]],
  "nemotron-3-ultra-free": [["nvidia", "nvidia/nemotron-3-ultra-550b-a55b"]],
  "glm-4.7-free": [["openrouter", "z-ai/glm-4.7"]],
  "ling-2.6-flash-free": [["openrouter", "inclusionai/ling-2.6-flash"]],
  "trinity-large-preview-free": [["vercel-ai-gateway", "arcee-ai/trinity-large-preview"]],
};

/** Register `/stats` for current-session and aggregate usage statistics. */
export default function sessionStatsExtension(pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show session statistics. /stats | /stats all [project] [days]",
    handler: async (args, ctx) => {
      const parsed = parseCommand(args);
      if (parsed.kind === "invalid") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }
      if (parsed.kind === "all") {
        await showAllSessionStats(parsed.days, parsed.project, ctx);
        return;
      }
      await showCurrentSessionStats(ctx);
    },
  });
}

async function showAllSessionStats(
  days: number | undefined,
  project: boolean,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const program = Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise(() =>
      project ? SessionManager.list(ctx.cwd) : SessionManager.listAll(),
    );
    if (sessions.length === 0) return { kind: "empty" as const };

    yield* Effect.sync(() => {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `Parsing ${sessions.length} sessions...`);
    });

    const pricing = createModelPricingResolver(ctx);
    const parsed = yield* Effect.forEach(
      sessions,
      (session) =>
        parseSessionFileEffect(session.path, pricing).pipe(
          Effect.map((stats): SessionStats => {
            const name = session.name || stats.name;
            return {
              ...stats,
              ...(name ? { name } : {}),
              project: session.cwd || undefined,
            };
          }),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      { concurrency: MAX_CONCURRENT_READS },
    );

    const stats = parsed.flatMap((value) => (value ? [value] : []));
    return stats.length === 0
      ? { kind: "unparseable" as const }
      : { kind: "success" as const, stats };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      }),
    ),
  );

  try {
    const result = await Effect.runPromise(program);
    if (result.kind === "empty") {
      ctx.ui.notify("No sessions found.", "info");
      return;
    }
    if (result.kind === "unparseable") {
      ctx.ui.notify("No parseable sessions found.", "warning");
      return;
    }
    if (project) {
      await showStatsModal(
        (width, theme) => buildAllStatsOutput(result.stats, days, width, theme, true),
        ctx,
      );
      return;
    }

    await showAllStatsBrowser(result.stats, days, ctx);
  } catch (error) {
    ctx.ui.notify(`Unable to load session statistics: ${errorMessage(error)}`, "error");
  }
}

async function showAllStatsBrowser(
  sessions: readonly SessionStats[],
  days: number | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  type View = "overview" | "projects" | "detail";
  let view: View = "overview";
  let selectedProject = 0;

  await showStatsModal(
    (width, theme) => {
      if (view === "overview") {
        return buildAllStatsOutput(sessions, days, width, theme);
      }

      const projects = buildProjectSummaries(sessions, days);
      if (view === "projects") {
        return buildProjectStatsOutput(sessions, days, width, theme, selectedProject);
      }

      const selected = projects[selectedProject];
      return selected
        ? buildAllStatsOutput(
            selected.sessions,
            days,
            width,
            theme,
            true,
            selected.project,
          )
        : "No project selected.";
    },
    ctx,
    (data) => {
      if (view === "overview") {
        if (data.toLowerCase() === "p") {
          view = "projects";
          return true;
        }
        return false;
      }

      if (view === "projects") {
        if (matchesKey(data, "escape")) {
          view = "overview";
          return true;
        }
        if (data === "j") {
          selectedProject = Math.min(
            selectedProject + 1,
            Math.max(0, buildProjectSummaries(sessions, days).length - 1),
          );
          return true;
        }
        if (data === "k") {
          selectedProject = Math.max(0, selectedProject - 1);
          return true;
        }
        if (data === "g") {
          selectedProject = 0;
          return true;
        }
        if (data === "G") {
          selectedProject = Math.max(
            0,
            buildProjectSummaries(sessions, days).length - 1,
          );
          return true;
        }
        if (matchesKey(data, "enter")) {
          view = "detail";
          return true;
        }
        return false;
      }

      if (matchesKey(data, "escape")) {
        view = "projects";
        return true;
      }
      return false;
    },
  );
}

async function showCurrentSessionStats(ctx: ExtensionCommandContext): Promise<void> {
  const currentFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";
  const pricing = createModelPricingResolver(ctx);
  const currentStats = parseCurrentBranch(
    ctx.sessionManager.getBranch() as SessionEntryLike[],
    currentFile,
    ctx.sessionManager.getSessionName() ?? undefined,
    pricing,
  );
  const subagentStats = await loadCurrentWorkspaceSubagentStats(ctx, currentFile, pricing);
  const stats = mergeSessionStats(
    [currentStats, ...subagentStats],
    currentFile,
    currentStats.name,
  );

  await showStatsModal(
    (width, theme) => buildCurrentSessionOutput(stats, width, theme),
    ctx,
  );
}

/** Load persisted subagent sessions belonging to the current workspace. */
async function loadCurrentWorkspaceSubagentStats(
  ctx: ExtensionCommandContext,
  currentFile: string,
  pricing: ModelPricingResolver,
): Promise<SessionStats[]> {
  try {
    const sessions = await SessionManager.list(ctx.cwd);
    const subagentSessions = sessions.filter(
      (session) =>
        session.path !== currentFile &&
        session.name?.startsWith(SUBAGENT_SESSION_PREFIX),
    );
    const parsed = await Effect.runPromise(
      Effect.forEach(
        subagentSessions,
        (session) =>
          parseSessionFileEffect(session.path, pricing).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        { concurrency: MAX_CONCURRENT_READS },
      ),
    );
    return parsed.flatMap((stats) => (stats ? [stats] : []));
  } catch {
    // Current-session statistics should still work if session discovery fails.
    return [];
  }
}

type ParsedCommand =
  | { readonly kind: "current" }
  | { readonly kind: "all"; readonly days?: number; readonly project: boolean }
  | { readonly kind: "invalid"; readonly message: string };

function parseCommand(args: string): ParsedCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "current" };
  if (parts[0]?.toLowerCase() !== "all" || parts.length > 3) {
    return {
      kind: "invalid",
      message: "Usage: /stats | /stats all [project] [days]",
    };
  }
  if (parts.length === 1) return { kind: "all", project: false };

  const hasProjectFilter = parts[1]?.toLowerCase() === "project";
  if (hasProjectFilter && parts.length === 2) {
    return { kind: "all", project: true };
  }
  if (hasProjectFilter && parts.length !== 3) {
    return {
      kind: "invalid",
      message: "Usage: /stats | /stats all [project] [days]",
    };
  }
  if (!hasProjectFilter && parts.length === 3) {
    return {
      kind: "invalid",
      message: "Usage: /stats | /stats all [project] [days]",
    };
  }

  const rawDays = hasProjectFilter ? parts[2] : parts[1];
  if (!rawDays || !/^\d+$/.test(rawDays)) {
    return { kind: "invalid", message: "Days must be a positive integer." };
  }
  const days = Number(rawDays);
  if (!Number.isSafeInteger(days) || days < 1) {
    return { kind: "invalid", message: "Days must be a positive integer." };
  }
  return { kind: "all", days, project: hasProjectFilter };
}

function createModelPricingResolver(
  ctx: ExtensionCommandContext,
): ModelPricingResolver {
  return (provider, modelId) => {
    const directModel = ctx.modelRegistry.find(provider, modelId);
    if (directModel && hasBillablePricing(directModel.cost)) return directModel.cost;
    if (!modelId.endsWith("-free")) return directModel?.cost;

    const baseModelId = modelId.slice(0, -"-free".length);
    const candidates = [
      ["opencode", baseModelId] as const,
      ["opencode-go", baseModelId] as const,
      ...(FREE_MODEL_PRICE_REFERENCES[modelId] ?? []),
    ];
    for (const [referenceProvider, referenceModelId] of candidates) {
      const referenceModel = ctx.modelRegistry.find(referenceProvider, referenceModelId);
      if (referenceModel && hasBillablePricing(referenceModel.cost)) {
        return { ...referenceModel.cost, source: "estimated" };
      }
    }

    // Do not present a free model's zero rate as a paid reference when no
    // equivalent exists; the dashboard will show it as unknown instead.
    return undefined;
  };
}

function hasBillablePricing(pricing: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): boolean {
  return [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite].some(
    (rate) => Number.isFinite(rate) && rate > 0,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
