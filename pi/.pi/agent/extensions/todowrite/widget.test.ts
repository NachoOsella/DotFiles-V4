import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { removeSessionState, setTodos, toggleWidgetVisible } from "./state.ts";
import { refreshWidget } from "./widget.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

type Widget =
  | undefined
  | string[]
  | ((
      tui: unknown,
      theme: Theme
    ) => { render(width: number): string[]; invalidate(): void });

function createWidgetContext(
  sessionId: string,
  mode: "tui" | "rpc" | "json" | "print",
  hasUI: boolean
): { ctx: ExtensionContext; getWidget(): Widget; calls: Widget[] } {
  let widget: Widget = undefined;
  const calls: Widget[] = [];
  const ctx = {
    mode,
    hasUI,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget: (_id: string, next: Widget) => {
        widget = next;
        calls.push(next);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, getWidget: () => widget, calls };
}

test("widget lines fit every width from 1 through 80", () => {
  const sessionId = "widget-width";
  removeSessionState(sessionId);
  setTodos(sessionId, [
    {
      content: "A very long todo item that must stay inside the terminal panel",
      status: "pending",
    },
    { content: "Finished item", status: "completed" },
  ]);
  toggleWidgetVisible(sessionId);
  const { ctx, getWidget } = createWidgetContext(sessionId, "tui", true);

  for (let width = 1; width <= 80; width += 1) {
    refreshWidget(ctx);
    const widget = getWidget();
    assert.equal(typeof widget, "function");
    const component = (
      widget as (
        tui: unknown,
        theme: Theme
      ) => { render(width: number): string[]; invalidate(): void }
    )({}, theme);
    const lines = component.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines)
      assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}`);
  }

  removeSessionState(sessionId);
});

test("widget uses a single truncated line at very narrow widths", () => {
  const sessionId = "widget-narrow";
  removeSessionState(sessionId);
  setTodos(sessionId, [{ content: "A long item", status: "in_progress" }]);
  toggleWidgetVisible(sessionId);
  const { ctx, getWidget } = createWidgetContext(sessionId, "tui", true);

  refreshWidget(ctx);
  const widget = getWidget();
  const component = (
    widget as (
      tui: unknown,
      theme: Theme
    ) => { render(width: number): string[]; invalidate(): void }
  )({}, theme);
  assert.equal(component.render(4).length, 1);
  assert.ok(visibleWidth(component.render(4)[0] ?? "") <= 4);
  assert.equal(component.render(8).length, 1);

  removeSessionState(sessionId);
});

test("widget does not install a component outside TUI mode", () => {
  const sessionId = "widget-mode";
  removeSessionState(sessionId);
  setTodos(sessionId, [{ content: "Active item", status: "pending" }]);
  toggleWidgetVisible(sessionId);

  const rpc = createWidgetContext(sessionId, "rpc", true);
  refreshWidget(rpc.ctx);
  assert.equal(typeof rpc.getWidget(), "undefined");
  assert.equal(typeof rpc.calls.at(-1), "undefined");

  const json = createWidgetContext(sessionId, "json", false);
  refreshWidget(json.ctx);
  assert.equal(json.calls.length, 0);

  const print = createWidgetContext(sessionId, "print", false);
  refreshWidget(print.ctx);
  assert.equal(print.calls.length, 0);

  removeSessionState(sessionId);
});
