/** TUI overlay for displaying long prompt content. Kept separate from entry for testability. */

/**
 * pi-desk (PI_DESK=1, RPC) shows multi-line notifications as a report sheet,
 * so the content goes to the GUI instead of stdout (which RPC redirects).
 * Returns true when it handled the report.
 */
export function deskReport(
  ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
  title: string,
  content: string,
): boolean {
  if (process.env.PI_DESK !== "1" || ctx.mode !== "rpc" || !ctx.hasUI) return false;
  ctx.ui.notify(`${title}\n\n${content}`, "info");
  return true;
}

export async function showInOverlayOrNotify(
  ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
  title: string,
  content: string,
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    if (deskReport(ctx, title, content)) return;
    console.log(`\n${title}\n${"=".repeat(title.length)}\n${content}\n`);
    ctx.ui.notify(title, "info");
    return;
  }

  try {
    await ctx.ui.custom(async (tui, theme, _keybindings, done) => {
      const { Text, Container } = await import("@earendil-works/pi-tui");
      const container = new Container();

      container.addChild(new Text(theme.fg("accent", title)));
      container.addChild(
        new Text(theme.fg("dim", "─".repeat(Math.min(title.length, 60)))),
      );

      const display =
        content.length > 20000
          ? content.slice(0, 20000) +
            `\n\n... truncado (${content.length - 20000} chars mas). Usa /prompt save para ver completo.`
          : content;

      const maxChunk = 6000;
      const lines = display.split("\n");
      let current = "";
      for (const line of lines) {
        if (current.length + line.length + 1 > maxChunk) {
          container.addChild(new Text(current));
          current = line;
        } else {
          current += (current ? "\n" : "") + line;
        }
      }
      if (current) container.addChild(new Text(current));

      container.addChild(new Text(""));
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "Enter/Esc/q para cerrar  •  /prompt save para guardar a archivo",
          ),
        ),
      );

      (container as unknown as { handleInput?: (data: string) => unknown }).handleInput = (
        data: string,
      ) => {
        if (data === "\r" || data === "\x1b" || data === "q" || data === "Q" || data === "\x03") {
          done(undefined);
          return { consume: true };
        }
        return undefined;
      };

      return container;
    }, { overlay: true });
  } catch {
    ctx.ui.notify(`${title} — contenido largo, usa /prompt save`, "info");
    console.log(content);
  }
}
