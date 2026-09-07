import assert from "node:assert/strict";
import test from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
  buildSnapshotText,
  findBranchSnapshot,
  MAX_SNAPSHOT_BYTES,
  maybeInjectSnapshot,
  retainedHasSnapshot,
  SNAPSHOT_CUSTOM_TYPE,
} from "./context.ts";
import type { Todo } from "./types.ts";

type ContextMessage = ContextEvent["messages"][number];

function todo(
  id: string,
  content: string,
  status: Todo["status"] = "pending"
): Todo {
  return { id, content, status };
}

function branchResult(items: unknown, isError = false): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todowrite",
      isError,
      details: { items },
    },
  };
}

function userMessage(text: string): ContextMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as unknown as ContextMessage;
}

function assistantToolCall(toolCallId: string): ContextMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId,
        toolName: "todowrite",
        input: { todos: [] },
      },
    ],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as unknown as ContextMessage;
}

function retainedToolResult(
  toolCallId: string,
  items: readonly Todo[]
): ContextMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "todowrite",
    content: [{ type: "text", text: "Todo list updated." }],
    details: {
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      in_progress: items.filter((item) => item.status === "in_progress").length,
      completed: items.filter((item) => item.status === "completed").length,
      current: null,
      items: items.map((item) => ({ ...item })),
    },
    isError: false,
    timestamp: Date.now(),
  } as unknown as ContextMessage;
}

function injectedText(message: ContextMessage): string {
  assert.equal(message.role, "custom");
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  assert.ok(Array.isArray(content));
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : ""
    )
    .join("");
}

test("injects a synthetic snapshot when the retained tail omits it", () => {
  const todos = [
    todo("1", "First work", "in_progress"),
    todo("2", "Second work", "pending"),
  ];
  const branch = [branchResult(todos)];
  const messages = [userMessage("continue")];

  const next = maybeInjectSnapshot(branch, messages);

  assert.ok(next);
  assert.equal(next.length, messages.length + 1);
  assert.equal(messages.length, 1);
  const injected = next.at(-1);
  assert.ok(injected);
  assert.equal(injected.role, "custom");
  assert.equal(
    (injected as { customType: unknown }).customType,
    SNAPSHOT_CUSTOM_TYPE
  );
  const text = injectedText(injected);
  assert.ok(text.includes("[1]"));
  assert.ok(text.includes("[2]"));
  assert.ok(text.includes("First work"));
  assert.ok(text.includes("Second work"));
});

test("skips injection when an equivalent snapshot is already visible", () => {
  const todos = [
    todo("1", "First work", "in_progress"),
    todo("2", "Second work", "pending"),
  ];
  const branch = [branchResult(todos)];
  const messages = [
    assistantToolCall("call_1"),
    retainedToolResult("call_1", todos),
  ];

  assert.ok(retainedHasSnapshot(messages, todos));
  assert.equal(maybeInjectSnapshot(branch, messages), undefined);
});

test("skips injection for finished plans and empty branches", () => {
  const finished = [todo("1", "Done work", "completed")];
  assert.equal(
    maybeInjectSnapshot([branchResult(finished)], [userMessage("hi")]),
    undefined
  );
  assert.equal(maybeInjectSnapshot([], [userMessage("hi")]), undefined);
  assert.equal(
    maybeInjectSnapshot([branchResult([], false)], [userMessage("hi")]),
    undefined
  );
});

test("skips error snapshots when deriving canonical state", () => {
  const branch = [branchResult([todo("1", "Bad work")], true)];
  assert.equal(findBranchSnapshot(branch), undefined);
  assert.equal(maybeInjectSnapshot(branch, [userMessage("hi")]), undefined);
});

test("repeated hooks do not multiply synthetic messages", () => {
  const todos = [todo("1", "Only work", "pending")];
  const branch = [branchResult(todos)];
  const base = [userMessage("continue")];

  const once = maybeInjectSnapshot(branch, base);
  assert.ok(once);
  assert.equal(once.filter((message) => message.role === "custom").length, 1);
  assert.equal(maybeInjectSnapshot(branch, once), undefined);
});

test("uses the current branch instead of another branch's state", () => {
  const stale = [todo("9", "Stale work", "pending")];
  const current = [todo("1", "Current work", "in_progress")];
  const messages = [
    assistantToolCall("call_1"),
    retainedToolResult("call_1", stale),
  ];

  const next = maybeInjectSnapshot([branchResult(current)], messages);

  assert.ok(next);
  const text = injectedText(next.at(-1)!);
  assert.ok(text.includes("Current work"));
  assert.ok(!text.includes("Stale work"));
});

test("preserves tool-call/result order when appending", () => {
  const stale = [todo("9", "Stale work", "pending")];
  const current = [todo("1", "Current work", "pending")];
  const messages = [
    userMessage("start"),
    assistantToolCall("call_1"),
    retainedToolResult("call_1", stale),
    userMessage("continue"),
  ];

  const next = maybeInjectSnapshot([branchResult(current)], messages);

  assert.ok(next);
  assert.equal(next.length, messages.length + 1);
  assert.deepEqual(next.slice(0, messages.length), messages);
});

test("caps injected text at 8 KiB while retaining every ID and status", () => {
  const todos = Array.from({ length: 20 }, (_, index) =>
    todo(
      `id-${index + 1}`,
      `Work ${index + 1} ` + "x".repeat(500),
      index === 0 ? "in_progress" : "pending"
    )
  );

  const text = buildSnapshotText(todos);

  assert.ok(
    new TextEncoder().encode(text).length <= MAX_SNAPSHOT_BYTES,
    `snapshot exceeded ${MAX_SNAPSHOT_BYTES} bytes`
  );
  for (const item of todos) {
    assert.ok(text.includes(`[${item.id}]`), `missing ${item.id}`);
  }
  assert.ok(text.includes("in_progress") || text.includes(">"));
  assert.ok(text.includes("omitted"));
});
