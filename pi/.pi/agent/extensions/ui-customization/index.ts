import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  DISCORD_ACTIVITY_CHANNEL,
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isDiscordActivityState,
  isGitInfoState,
  isModelInfoState,
  sanitizeGitInfoState,
  sanitizeModelInfoState,
} from "../shared/dashboard-state.ts";
import {
  appendOverflowIndicator,
  columns,
  fitFooterSegments,
  normalizeWidth,
  packExtensionStatuses,
} from "./src/dashboard-layout.ts";

interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

const TITLE_LINES = [
  "   ███████████████████████████╗   ",
  "   ╚══██████╔════════██████╔══╝   ",
  "      ██████║        ██████║      ",
  "      ██████║        ██████║      ",
  "      ██████║        ██████║      ",
  "      ██████║        ██████║      ",
  "      ██████║        ███████╗     ",
  "      ██████║        ╚████████╗   ",
  "      ██████║          ╚███████╗  ",
  "      ╚═════╝            ╚═════╝  ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// Limitation (P11 step 4): pi exposes no public API to hide the theme
// resource section, so the recursive private-tree splice below is retained
// pending approval. Do NOT replace it with another private-tree hack; if
// approval never comes, the section stays visible and this comment records
// why. Header defaults are likewise unchanged without approval: the
// compact one-line policy lives as a tested pure helper
// (buildHeaderLines in ./src/dashboard-layout.ts) and is not wired here.
function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}

function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

function hideThemesSection(component: RenderableNode) {
  if (!hasChildren(component)) return false;

  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();

    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] &&
        renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }

    if (hideThemesSection(child)) return true;
  }

  return false;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let discordActivityActive = false;
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let themeRemovalTimers: Array<ReturnType<typeof setTimeout>> = [];

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    // Finite-number sanitization at consumption: the shared validator
    // accepts legacy payloads as-is, so NaN/Infinity are rejected here.
    modelInfo = sanitizeModelInfoState(value);
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = sanitizeGitInfoState(value);
    requestRender?.();
  });

  const stopDiscordActivityListener = pi.events.on(
    DISCORD_ACTIVITY_CHANNEL,
    (value) => {
      if (!isDiscordActivityState(value)) return;
      discordActivityActive = value.active;
      requestRender?.();
    },
  );

  function scheduleThemeRemoval(tui: DashboardTui) {
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];

    for (const delay of [0, 50, 250, 1_000]) {
      themeRemovalTimers.push(
        setTimeout(() => {
          if (hideThemesSection(tui)) tui.requestRender(true);
        }, delay),
      );
    }
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    // Resolved once per session: render must not do filesystem/process work.
    const formattedDirectory = formatDirectory(ctx.cwd);

    ctx.ui.setHeader((tui, theme) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();
      scheduleThemeRemoval(tui);

      return {
        render(width: number) {
          // Use the active Pi theme rather than hardcoded terminal colors.
          const logo = TITLE_LINES.map((line) =>
            center(theme.bold(theme.fg("borderAccent", line)), width),
          );
          const subtitle = center(
            theme.bold(theme.fg("borderAccent", title)),
            width,
          );
          return ["", ...logo, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const safeWidth = normalizeWidth(width);
          // `~` marks live streaming estimates; measured cadences render
          // bare. Falls back to the generating flag for payloads that
          // predate throughputIsEstimate.
          const isEstimate =
            modelInfo.throughputIsEstimate ?? modelInfo.generating;
          const fit = fitFooterSegments({
            width: safeWidth,
            directory: formattedDirectory,
            provider: modelInfo.provider,
            modelId: modelInfo.modelId,
            thinking: modelInfo.thinking,
            contextPercent: modelInfo.contextPercent,
            contextWindow: modelInfo.contextWindow,
            cost: modelInfo.cost,
            tokensPerSecond: modelInfo.tokensPerSecond,
            throughputIsEstimate: isEstimate,
            branch: gitInfo.branch,
            changedFiles: gitInfo.changedFiles,
            pullRequestNumber: gitInfo.pullRequest?.number ?? null,
            // Forward-compatible freshness: git-info does not emit stale
            // yet (follow-up on the producer side); absent means fresh.
            gitStale: gitInfo.stale,
          });

          const directory = theme.fg("text", fit.row1Left);
          // Reattach the PR hyperlink when the PR segment survived
          // degradation. The fitted label carries the exact `PR #N` text.
          let gitDisplay = fit.row2Right;
          if (!fit.dropped.includes("pr") && gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            gitDisplay = gitDisplay.replace(prLabel, linkedPr);
          }

          // Active-work indicator takes priority over truncation; columns()
          // truncates only as a last resort.
          let modelStatus = theme.fg("muted", fit.row1Right);
          if (discordActivityActive) {
            modelStatus += ` ${theme.fg("borderAccent", "●")}`;
          }

          const lines = [
            columns(directory, modelStatus, safeWidth),
            columns(
              theme.fg("muted", fit.row2Left),
              theme.fg("muted", gitDisplay),
              safeWidth,
            ),
          ];

          // Extension statuses pack into a single overflow row. Statuses are
          // opaque text (never parsed); anything that does not fit is
          // counted as `+N more`, never silently deleted.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          const packed = packExtensionStatuses(statusLines, safeWidth, 1);
          if (packed.lines.length > 0) {
            lines.push(
              packed.overflow > 0
                ? appendOverflowIndicator(
                    packed.lines[0]!,
                    packed.overflow,
                    safeWidth,
                  )
                : packed.lines[0]!,
            );
          } else if (packed.overflow > 0) {
            lines.push(truncateToWidth(`+${packed.overflow} more`, safeWidth));
          }

          return lines;
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    discordActivityActive = false;
    install(ctx);
  });

  pi.on("resources_discover", () => {
    if (activeTui) scheduleThemeRemoval(activeTui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    stopDiscordActivityListener();
    for (const timer of themeRemovalTimers) clearTimeout(timer);
    themeRemovalTimers = [];
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
