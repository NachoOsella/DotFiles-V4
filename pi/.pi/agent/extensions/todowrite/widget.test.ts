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

function renderLines(
  getWidget: () => Widget,
  width: number,
  tui: unknown = {}
): string[] {
  const widget = getWidget();
  assert.equal(typeof widget, "function");
  return (
    widget as (
      tui: unknown,
      theme: Theme
    ) => { render(width: number): string[]; invalidate(): void }
  )(tui, theme).render(width);
}

function planTodos(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    content: `Task ${index + 1}`,
    status: (index === 0 ? "in_progress" : "pending") as
      "in_progress" | "pending",
  }));
}

test("widget caps a 20-item plan at five content rows", () => {
  const sessionId = "widget-budget";
  removeSessionState(sessionId);
  setTodos(sessionId, planTodos(20));
  toggleWidgetVisible(sessionId);
  const { ctx, getWidget } = createWidgetContext(sessionId, "tui", true);

  refreshWidget(ctx);
  const lines = renderLines(getWidget, 80);

  assert.ok(
    lines.length <= 7,
    `20-item plan consumed ${lines.length} widget rows`
  );
  assert.ok(lines.some((line) => line.includes("0/20 done")));
  assert.ok(lines.some((line) => line.includes("[1]")));

  removeSessionState(sessionId);
});

test("widget summarizes completed items instead of rendering every row", () => {
  const sessionId = "widget-completed-summary";
  removeSessionState(sessionId);
  setTodos(sessionId, [
    { id: "1", content: "Active work", status: "in_progress" },
    { id: "2", content: "Upcoming work", status: "pending" },
    { id: "3", content: "Finished one", status: "completed" },
    { id: "4", content: "Finished two", status: "completed" },
  ]);
  toggleWidgetVisible(sessionId);
  const { ctx, getWidget } = createWidgetContext(sessionId, "tui", true);

  refreshWidget(ctx);
  const lines = renderLines(getWidget, 80);

  assert.deepEqual(lines.length, 5);
  assert.ok(!lines.some((line) => line.includes("Finished one")));
  assert.ok(!lines.some((line) => line.includes("Finished two")));
  assert.ok(lines.some((line) => line.includes("2/4 done")));
  assert.ok(lines.some((line) => line.includes("[1] Active work")));

  removeSessionState(sessionId);
});

test("widget shrinks its content budget on short terminals", () => {
  const sessionId = "widget-short-terminal";
  removeSessionState(sessionId);
  setTodos(sessionId, planTodos(20));
  toggleWidgetVisible(sessionId);
  const { ctx, getWidget } = createWidgetContext(sessionId, "tui", true);

  refreshWidget(ctx);
  const lines = renderLines(getWidget, 80, { terminal: { rows: 8 } });

  assert.ok(
    lines.length <= 4,
    `short terminal consumed ${lines.length} widget rows`
  );

  removeSessionState(sessionId);
});

test("widget strips control characters from model-authored text", () => {
  const sessionId = "widget-safe-text";
  removeSessionState(sessionId);
  setTodos(sessionId, [
    {
      id: "1\n[9] injected",
      content: "Line one\nLine two\u001b[31mred",
      status: "in_progress",
    },
  ]);
  toggleWidgetVisible(sessionId);
  const { ctx, getWidget } = createWidgetContext(sessionId, "tui", true);

  refreshWidget(ctx);
  const lines = renderLines(getWidget, 80);

  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(!line.includes("\n"));
    assert.ok(!line.includes("\u001b[31m"));
    assert.ok(visibleWidth(line) <= 80);
  }

  removeSessionState(sessionId);
});

test("widget lines fit every width from 1 through 80", () => {
  const sessionId = "widget-width";
  removeSessionState(sessionId);
  setTodos(sessionId, [
    {
      id: "1",
      content: "A very long todo item that must stay inside the terminal panel",
      status: "pending",
    },
    { id: "2", content: "Finished item", status: "completed" },
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
  setTodos(sessionId, [
    { id: "1", content: "A long item", status: "in_progress" },
  ]);
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
  setTodos(sessionId, [
    { id: "1", content: "Active item", status: "pending" },
  ]);
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
