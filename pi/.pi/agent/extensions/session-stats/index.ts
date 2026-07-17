/** Session statistics command backed by bounded, fault-tolerant Effect pipelines. */

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { showStatsModal } from "./modal.ts";
import { buildAllStatsOutput, buildCurrentSessionOutput } from "./output.ts";
import { parseCurrentBranch, parseSessionFileEffect } from "./parser.ts";
import type { SessionEntryLike, SessionStats } from "./types.ts";

const STATUS_KEY = "session-stats";
const MAX_CONCURRENT_READS = 8;

/** Register `/stats` for current-session and aggregate usage statistics. */
export default function sessionStatsExtension(pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show session statistics. /stats | /stats all [days]",
    handler: async (args, ctx) => {
      const parsed = parseCommand(args);
      if (parsed.kind === "invalid") {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }
      if (parsed.kind === "all") {
        await showAllSessionStats(parsed.days, ctx);
        return;
      }
      await showCurrentSessionStats(ctx);
    },
  });
}

async function showAllSessionStats(
  days: number | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const program = Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise(() => SessionManager.listAll());
    if (sessions.length === 0) return { kind: "empty" as const };

    yield* Effect.sync(() => {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `Parsing ${sessions.length} sessions...`);
    });

    const parsed = yield* Effect.forEach(
      sessions,
      (session) =>
        parseSessionFileEffect(session.path).pipe(
          Effect.map((stats): SessionStats => {
            const name = session.name || stats.name;
            return name ? { ...stats, name } : stats;
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
    await showStatsModal(
      (width, theme) => buildAllStatsOutput(result.stats, days, width, theme),
      ctx,
    );
  } catch (error) {
    ctx.ui.notify(`Unable to load session statistics: ${errorMessage(error)}`, "error");
  }
}

async function showCurrentSessionStats(ctx: ExtensionCommandContext): Promise<void> {
  const stats = parseCurrentBranch(
    ctx.sessionManager.getBranch() as SessionEntryLike[],
    ctx.sessionManager.getSessionFile() ?? "ephemeral",
    ctx.sessionManager.getSessionName() ?? undefined,
  );
  await showStatsModal(
    (width, theme) => buildCurrentSessionOutput(stats, width, theme),
    ctx,
  );
}

type ParsedCommand =
  | { readonly kind: "current" }
  | { readonly kind: "all"; readonly days?: number }
  | { readonly kind: "invalid"; readonly message: string };

function parseCommand(args: string): ParsedCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "current" };
  if (parts[0]?.toLowerCase() !== "all" || parts.length > 2) {
    return { kind: "invalid", message: "Usage: /stats | /stats all [days]" };
  }
  if (parts.length === 1) return { kind: "all" };

  const rawDays = parts[1] ?? "";
  if (!/^\d+$/.test(rawDays)) {
    return { kind: "invalid", message: "Days must be a positive integer." };
  }
  const days = Number(rawDays);
  if (!Number.isSafeInteger(days) || days < 1) {
    return { kind: "invalid", message: "Days must be a positive integer." };
  }
  return { kind: "all", days };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
