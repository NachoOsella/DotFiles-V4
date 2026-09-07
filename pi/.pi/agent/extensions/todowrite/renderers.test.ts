import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderTodoResult } from "./renderers.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function renderText(
  result: Parameters<typeof renderTodoResult>[0],
  options: Parameters<typeof renderTodoResult>[1]
) {
  return renderTodoResult(result, options, theme, { isError: false })
    .render(200)
    .map((line) => line.trimEnd());
}

test("renderer displays validation errors from renderer context", () => {
  const lines = renderTodoResult(
    {
      content: [{ type: "image" }, { type: "text", text: "Invalid todo list" }],
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: true }
  )
    .render(200)
    .map((line) => line.trimEnd());

  assert.deepEqual(lines, ["Invalid todo list"]);
});

test("renderer uses a safe fallback for errors without text", () => {
  const lines = renderTodoResult(
    { content: [{ type: "image" }] },
    { expanded: false, isPartial: false },
    theme,
    {
      isError: true,
    }
  )
    .render(200)
    .map((line) => line.trimEnd());

  assert.deepEqual(lines, ["Error"]);
});

test("renderer displays partial state instead of a completed list", () => {
  const lines = renderText(
    {
      content: [{ type: "text", text: "Todo list updated" }],
      details: {
        total: 1,
        pending: 1,
        in_progress: 0,
        completed: 0,
        current: null,
        items: [{ id: "1", content: "Pending task", status: "pending" }],
      },
    },
    { expanded: false, isPartial: true }
  );

  assert.deepEqual(lines, ["Updating todo list..."]);
});

test("renderer keeps successful collapsed and expanded views", () => {
  const result = {
    content: [{ type: "text", text: "Todo list updated" }],
    details: {
      total: 2,
      pending: 1,
      in_progress: 0,
      completed: 1,
      current: null,
      items: [
        { id: "1", content: "Pending task", status: "pending" as const },
        { id: "2", content: "Done task", status: "completed" as const },
      ],
    },
  };

  assert.deepEqual(renderText(result, { expanded: false, isPartial: false }), [
    "1/2 done",
  ]);
  assert.deepEqual(renderText(result, { expanded: true, isPartial: false }), [
    "1/2 done",
    "",
    "  [ ] [1] Pending task",
    "  [✓] [2] Done task",
  ]);
});

test("renderer collapsed view names the current item with its stable ID", () => {
  const lines = renderText(
    {
      content: [{ type: "text", text: "Todo list updated" }],
      details: {
        total: 3,
        pending: 2,
        in_progress: 1,
        completed: 0,
        current: "Active work",
        items: [
          {
            id: "a",
            content: "Active work",
            status: "in_progress" as const,
          },
          {
            id: "b",
            content: "Later work",
            status: "pending" as const,
          },
          {
            id: "c",
            content: "More work",
            status: "pending" as const,
          },
        ],
      },
    },
    { expanded: false, isPartial: false }
  );

  assert.deepEqual(lines, ["> [a] Active work  0/3 done"]);
});

test("renderer strips control characters from model-authored text", () => {
  const lines = renderText(
    {
      content: [{ type: "text", text: "Todo list updated" }],
      details: {
        total: 1,
        pending: 0,
        in_progress: 1,
        completed: 0,
        current: "Line one\nLine two",
        items: [
          {
            id: "1\n[9] injected",
            content: "Line one\nLine two\u001b[31mred",
            status: "in_progress" as const,
          },
        ],
      },
    },
    { expanded: true, isPartial: false }
  );

  for (const line of lines) {
    assert.ok(!line.includes("\n"));
    assert.ok(!line.includes("\u001b[31m"));
  }
  assert.ok(lines.some((line) => line.includes("[1 [9] injected]")));
});

test("renderer prefers the stored current ID over item order", () => {
  const lines = renderText(
    {
      content: [{ type: "text", text: "Todo list updated" }],
      details: {
        total: 2,
        pending: 1,
        in_progress: 1,
        completed: 0,
        current: "stale text",
        currentId: "2",
        items: [
          { id: "1", content: "Pending task", status: "pending" as const },
          { id: "2", content: "Active task", status: "in_progress" as const },
        ],
      },
    },
    { expanded: false, isPartial: false }
  );

  assert.deepEqual(lines, ["> [2] Active task  0/2 done"]);
});
