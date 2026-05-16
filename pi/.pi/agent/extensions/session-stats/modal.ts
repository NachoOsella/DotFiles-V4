import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** Show stats output in a lightweight custom modal or notify fallback. */
export function showStatsModal(buildFn: (width: number, theme?: any) => string, ctx: ExtensionCommandContext): void {
  if (!ctx.hasUI) {
    ctx.ui.notify(buildFn(56), "info");
    return;
  }

  ctx.ui.custom((_tui: any, theme: any, _kb: any, done: (value?: unknown) => void) => {
    const output = new Text("", 0, 0);

    return {
      render: (width: number) => {
        const boxWidth = Math.max(2, Math.min(56, width - 2));
        const rendered = buildFn(boxWidth, theme)
          .split("\n")
          .map((line) => truncateToWidth(line, width, "", false))
          .join("\n");
        output.setText(rendered);
        return output.render(width);
      },
      invalidate: () => output.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
          done(undefined);
        }
      },
    };
  });
}
