import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import todowriteExtension from "./index.ts";
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
