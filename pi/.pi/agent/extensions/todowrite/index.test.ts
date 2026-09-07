import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import todowriteExtension, { normalizeTodoArguments } from "./index.ts";
import {
  getTodos,
  isWidgetVisible,
  removeSessionState,
  setTodos,
  toggleWidgetVisible,
} from "./state.ts";
import type { Todo } from "./types.ts";

type TestHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredTool = {
  executionMode?: string;
  prepareArguments?: (args: unknown) => unknown;
  execute?: (...args: unknown[]) => Promise<{ details?: unknown }>;
};

type TestContextOptions = {
  sessionId: string;
  branch: readonly unknown[];
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
};

function createContext(options: TestContextOptions): ExtensionContext {
  return {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getBranch: () => [...options.branch],
    },
    ui: {
      setWidget: () => undefined,
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function createExtensionHarness() {
  const handlers = new Map<string, TestHandler>();
  const tools: RegisteredTool[] = [];
  const pi = {
    on(event: string, handler: TestHandler) {
      handlers.set(event, handler);
    },
    registerShortcut: () => undefined,
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  todowriteExtension(pi);
  return { handlers, tools };
}

function snapshot(items: unknown): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todowrite",
      details: { items },
    },
  };
}

function snapshotWithError(items: unknown, isError: boolean): unknown {
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

function todo(content: string, status: Todo["status"] = "pending"): Todo {
  return { id: content, content, status };
}

test("restores the current branch on session start", () => {
  const sessionId = "session-start";
  removeSessionState(sessionId);
  const branch = [snapshot([todo("Restore me")])];
  const { handlers } = createExtensionHarness();
  const ctx = createContext({ sessionId, branch });

  handlers.get("session_start")?.({}, ctx);

  assert.deepEqual(getTodos(sessionId), [todo("Restore me")]);
  removeSessionState(sessionId);
});

test("restores the current branch after session_tree", () => {
  const sessionId = "session-tree";
  removeSessionState(sessionId);
  const branch: unknown[] = [snapshot([todo("Old branch")])];
  const { handlers } = createExtensionHarness();
  const ctx = createContext({ sessionId, branch });

  handlers.get("session_start")?.({}, ctx);
  branch.splice(0, branch.length, snapshot([todo("New branch")]));
  handlers.get("session_tree")?.({}, ctx);

  assert.deepEqual(getTodos(sessionId), [todo("New branch")]);
  removeSessionState(sessionId);
});

test("restored pending state may complete directly", async () => {
  const sessionId = "restored-validation";
  removeSessionState(sessionId);
  const { handlers, tools } = createExtensionHarness();
  const branch: unknown[] = [
    snapshot([todo("Restore me", "completed")]),
  ];
  const ctx = createContext({ sessionId, branch });
  const execute = tools[0]?.execute;
  assert.ok(execute);

  handlers.get("session_start")?.({}, ctx);
  branch.splice(0, branch.length, snapshot([todo("Restore me")]));
  handlers.get("session_tree")?.({}, ctx);
  await execute(
    "call",
    { todos: [todo("Restore me", "completed")] },
    undefined,
    undefined,
    ctx
  );
  assert.deepEqual(getTodos(sessionId), [todo("Restore me", "completed")]);
  removeSessionState(sessionId);
});

test("clears state when the active branch has no todo snapshot", () => {
  const sessionId = "empty-branch";
  removeSessionState(sessionId);
  setTodos(sessionId, [todo("Stale state")]);
  const { handlers } = createExtensionHarness();
  const ctx = createContext({ sessionId, branch: [] });

  handlers.get("session_tree")?.({}, ctx);

  assert.deepEqual(getTodos(sessionId), []);
  removeSessionState(sessionId);
});

test("skips malformed latest snapshots and restores the older valid snapshot", () => {
  const sessionId = "malformed-latest";
  removeSessionState(sessionId);
  const branch = [
    snapshot([todo("Older valid snapshot")]),
    snapshot([todo("first", "in_progress"), todo("second", "in_progress")]),
  ];
  const { handlers } = createExtensionHarness();

  handlers.get("session_start")?.({}, createContext({ sessionId, branch }));

  assert.deepEqual(getTodos(sessionId), [todo("Older valid snapshot")]);
  removeSessionState(sessionId);
});

test("skips newer error snapshots and restores the older valid snapshot", () => {
  const sessionId = "error-latest";
  removeSessionState(sessionId);
  const branch = [
    snapshot([todo("Older valid snapshot")]),
    snapshotWithError([todo("Newer error snapshot")], true),
  ];
  const { handlers } = createExtensionHarness();

  handlers.get("session_start")?.({}, createContext({ sessionId, branch }));

  assert.deepEqual(getTodos(sessionId), [todo("Older valid snapshot")]);
  removeSessionState(sessionId);
});

test("restores successful empty snapshots instead of falling through", () => {
  const sessionId = "empty-snapshot";
  removeSessionState(sessionId);
  const branch = [
    snapshot([todo("Older valid snapshot")]),
    snapshotWithError([], false),
  ];
  const { handlers } = createExtensionHarness();

  handlers.get("session_start")?.({}, createContext({ sessionId, branch }));

  assert.deepEqual(getTodos(sessionId), []);
  removeSessionState(sessionId);
});

test("restores legacy snapshots without IDs or isError", () => {
  const sessionId = "legacy-snapshot";
  removeSessionState(sessionId);
  const branch = [snapshot([{ content: "Legacy work", status: "pending" }])];
  const { handlers } = createExtensionHarness();

  handlers.get("session_start")?.({}, createContext({ sessionId, branch }));

  assert.deepEqual(getTodos(sessionId), [
    { id: "1", content: "Legacy work", status: "pending" },
  ]);
  removeSessionState(sessionId);
});

test("skips malformed error data and restores the older valid snapshot", () => {
  const sessionId = "malformed-error";
  removeSessionState(sessionId);
  const branch = [
    snapshot([todo("Older valid snapshot")]),
    snapshotWithError({ not: "a list" }, true),
  ];
  const { handlers } = createExtensionHarness();

  handlers.get("session_start")?.({}, createContext({ sessionId, branch }));

  assert.deepEqual(getTodos(sessionId), [todo("Older valid snapshot")]);
  removeSessionState(sessionId);
});

test("aborted execution does not mutate state", async () => {
  const sessionId = "aborted-execute";
  removeSessionState(sessionId);
  setTodos(sessionId, [todo("Original")]);
  const { tools } = createExtensionHarness();
  const execute = tools[0]?.execute;
  assert.ok(execute);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    execute(
      "call",
      { todos: [todo("Mutated")] },
      controller.signal,
      undefined,
      createContext({ sessionId, branch: [] })
    )
  );
  assert.deepEqual(getTodos(sessionId), [todo("Original")]);
  removeSessionState(sessionId);
});

test("getTodos returns a defensive copy", () => {
  const sessionId = "snapshot-isolation";
  removeSessionState(sessionId);
  setTodos(sessionId, [todo("Original")]);

  const stored = getTodos(sessionId);
  (stored as Todo[]).push(todo("Injected"));
  (stored[0] as { content: string }).content = "Mutated after read";

  assert.deepEqual(getTodos(sessionId), [todo("Original")]);
  removeSessionState(sessionId);
});

test("marks todowrite execution as sequential", () => {
  const { tools } = createExtensionHarness();
  assert.equal(tools[0]?.executionMode, "sequential");
});

test("setTodos stores a defensive copy", () => {
  const sessionId = "defensive-copy";
  removeSessionState(sessionId);
  const input: Array<{
    id: string;
    content: string;
    status: Todo["status"];
  }> = [todo("Original")];

  setTodos(sessionId, input);
  input[0]!.content = "Mutated after storage";

  assert.deepEqual(getTodos(sessionId), [todo("Original")]);
  removeSessionState(sessionId);
});

test("tool results keep the complete replacement snapshot in details", async () => {
  const sessionId = "details";
  removeSessionState(sessionId);
  const { tools } = createExtensionHarness();
  const execute = tools[0]?.execute;
  assert.ok(execute);

  const result = await execute(
    "call",
    { todos: [todo("First"), todo("Second", "pending")] },
    undefined,
    undefined,
    createContext({ sessionId, branch: [] })
  );

  assert.deepEqual((result.details as { items: readonly Todo[] }).items, [
    todo("First"),
    todo("Second", "pending"),
  ]);
  removeSessionState(sessionId);
});

test("session shutdown removes todos and widget visibility", () => {
  const sessionId = "shutdown";
  removeSessionState(sessionId);
  setTodos(sessionId, [todo("Remove me")]);
  toggleWidgetVisible(sessionId);
  const { handlers } = createExtensionHarness();

  handlers.get("session_shutdown")?.(
    {},
    createContext({ sessionId, branch: [] })
  );

  assert.deepEqual(getTodos(sessionId), []);
  assert.equal(isWidgetVisible(sessionId), false);
});

function userTextMessage(text: string): unknown {
  return { role: "user", content: text, timestamp: Date.now() };
}

function messageText(message: unknown): string {
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : ""
    )
    .join("");
}

test("context hook injects the current branch snapshot when it is missing", () => {
  const sessionId = "context-inject";
  removeSessionState(sessionId);
  const branch = [snapshot([todo("Current work", "in_progress")])];
  const { handlers } = createExtensionHarness();
  const ctx = createContext({ sessionId, branch });

  const result = handlers.get("context")?.(
    { messages: [userTextMessage("continue")] },
    ctx
  ) as { messages?: unknown[] } | undefined;

  assert.ok(result?.messages);
  assert.equal(result.messages.length, 2);
  assert.ok(messageText(result.messages[1]).includes("Current work"));
  removeSessionState(sessionId);
});

test("repeated context hooks do not multiply synthetic messages", () => {
  const sessionId = "context-repeat";
  removeSessionState(sessionId);
  const branch = [snapshot([todo("Current work")])];
  const { handlers } = createExtensionHarness();
  const ctx = createContext({ sessionId, branch });
  const handler = handlers.get("context");
  assert.ok(handler);

  const first = handler({ messages: [userTextMessage("hi")] }, ctx) as {
    messages?: unknown[];
  };
  assert.ok(first?.messages);
  const second = handler({ messages: first.messages! }, ctx);
  assert.equal(second, undefined);
  removeSessionState(sessionId);
});

test("context hook follows branch changes instead of stale state", () => {
  const sessionId = "context-branch";
  removeSessionState(sessionId);
  const { handlers } = createExtensionHarness();
  setTodos(sessionId, [todo("Stale in-memory work")]);
  const branch = [snapshot([todo("Fresh branch work", "pending")])];
  const ctx = createContext({ sessionId, branch });

  const result = handlers.get("context")?.(
    { messages: [userTextMessage("hi")] },
    ctx
  ) as { messages?: unknown[] } | undefined;

  assert.ok(result?.messages);
  assert.ok(messageText(result.messages[1]).includes("Fresh branch work"));
  assert.ok(!messageText(result.messages[1]).includes("Stale in-memory work"));
  removeSessionState(sessionId);
});

test("context hook makes no UI calls in headless mode", () => {
  const sessionId = "context-headless";
  removeSessionState(sessionId);
  const branch = [snapshot([todo("Current work")])];
  const { handlers } = createExtensionHarness();
  let widgetCalls = 0;
  let notifyCalls = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [...branch],
    },
    ui: {
      setWidget: () => {
        widgetCalls += 1;
      },
      notify: () => {
        notifyCalls += 1;
      },
    },
  } as unknown as ExtensionContext;

  const result = handlers.get("context")?.(
    { messages: [userTextMessage("hi")] },
    ctx
  ) as { messages?: unknown[] } | undefined;

  assert.ok(result?.messages);
  assert.equal(widgetCalls, 0);
  assert.equal(notifyCalls, 0);
  removeSessionState(sessionId);
});

test("normalizeTodoArguments wraps a single object in an array", () => {
  assert.deepEqual(
    normalizeTodoArguments({
      todos: { id: "1", content: "Solo work", status: "pending" },
    }),
    { todos: [{ id: "1", content: "Solo work", status: "pending" }] }
  );
});

test("normalizeTodoArguments coerces numeric IDs and status aliases", () => {
  assert.deepEqual(
    normalizeTodoArguments({
      todos: [
        { id: 1, content: "First", status: "done" },
        { id: "2", content: "Second", status: "In-Progress" },
        { id: "3", content: "Third", status: "TODO" },
      ],
    }),
    {
      todos: [
        { id: "1", content: "First", status: "completed" },
        { id: "2", content: "Second", status: "in_progress" },
        { id: "3", content: "Third", status: "pending" },
      ],
    }
  );
});

test("normalizeTodoArguments leaves unknown shapes for schema validation", () => {
  assert.deepEqual(normalizeTodoArguments(null), null);
  assert.deepEqual(
    normalizeTodoArguments({
      todos: [{ id: "1", content: "Kept", status: "bogus" }],
    }),
    { todos: [{ id: "1", content: "Kept", status: "bogus" }] }
  );
});

test("registered tool exposes the argument normalizer", () => {
  const { tools } = createExtensionHarness();
  assert.equal(typeof tools[0]?.prepareArguments, "function");
  assert.deepEqual(
    tools[0]?.prepareArguments?.({
      todos: { id: 7, content: "Via tool", status: "DONE" },
    }),
    { todos: [{ id: "7", content: "Via tool", status: "completed" }] }
  );
});
