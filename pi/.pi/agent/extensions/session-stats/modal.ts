import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** Render statistics as a centered, width-safe dashboard overlay. */
export async function showStatsModal(
  buildOutput: (width: number, theme?: Theme) => string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(buildOutput(60), "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let cachedWidth: number | undefined;
      let cachedLines: string[] | undefined;
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        done();
      };

      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const dashboardWidth = Math.max(32, width);
          cachedLines = buildOutput(dashboardWidth, theme)
            .split("\n")
            .map((line) => truncateToWidth(line, width, "", false));
          cachedWidth = width;
          return cachedLines;
        },
        invalidate(): void {
          cachedWidth = undefined;
          cachedLines = undefined;
        },
        handleInput(data: string): void {
          if (
            matchesKey(data, "escape") ||
            matchesKey(data, "enter") ||
            data.toLowerCase() === "q"
          ) {
            close();
            return;
          }
          tui.requestRender();
        },
        dispose(): void {
          closed = true;
          cachedLines = undefined;
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 62,
        minWidth: 40,
        maxHeight: "90%",
        margin: 1,
      },
    },
  );
}
