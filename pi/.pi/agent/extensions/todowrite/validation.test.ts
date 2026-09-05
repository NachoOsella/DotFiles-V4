import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { TodoWriteParams } from "./schema.ts";
import type { Todo, TodoStatus } from "./types.ts";
import { decodeStoredTodos, validateTodos } from "./validation.ts";

function todo(id: string, content: string, status: TodoStatus): Todo {
  return { id, content, status };
}

async function rejectsTransition(
  nextTodos: readonly Todo[],
  previousTodos: readonly Todo[]
): Promise<void> {
  const exit = await Effect.runPromiseExit(
    validateTodos(nextTodos, previousTodos)
  );
  assert.equal(Exit.isFailure(exit), true);
}

test("validateTodos trims IDs and content and preserves valid state", async () => {
  const todos = await Effect.runPromise(
    validateTodos([
      { id: " 1 ", content: "  Inspect implementation  ", status: "in_progress" },
      { id: " 2 ", content: "Run tests", status: "pending" },
    ])
  );

  assert.deepEqual(todos, [
    todo("1", "Inspect implementation", "in_progress"),
    todo("2", "Run tests", "pending"),
  ]);
});

test("validateTodos accepts the normal pending to completed lifecycle", async () => {
  const initial = await Effect.runPromise(
    validateTodos([todo("1", "Implement feature", "pending")])
  );
  const started = await Effect.runPromise(
    validateTodos([todo("1", "Implement feature", "in_progress")], initial)
  );
  const completed = await Effect.runPromise(
    validateTodos([todo("1", "Implement feature", "completed")], started)
  );

  assert.deepEqual(completed, [todo("1", "Implement feature", "completed")]);
});

test("validateTodos allows pending items to complete directly", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [todo("1", "Implement feature", "completed")],
      [todo("1", "Implement feature", "pending")]
    )
  );

  assert.deepEqual(todos, [todo("1", "Implement feature", "completed")]);
});

test("validateTodos rejects starting completed from an empty list", async () => {
  await rejectsTransition(
    [todo("1", "Implement feature", "completed")],
    []
  );
});

test("validateTodos rejects returning in-progress items to pending", async () => {
  await rejectsTransition(
    [todo("1", "Implement feature", "pending")],
    [todo("1", "Implement feature", "in_progress")]
  );
});

test("validateTodos rejects completed items that regress in an active plan", async () => {
  for (const status of ["pending", "in_progress"] as const) {
    await rejectsTransition(
      [
        todo("1", "Finished work", status),
        todo("2", "Remaining work", "pending"),
      ],
      [
        todo("1", "Finished work", "completed"),
        todo("2", "Remaining work", "pending"),
      ]
    );
  }
});

test("validateTodos starts a fresh plan after all previous todos complete", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [
        todo("1", "Inspect the next task", "in_progress"),
        todo("2", "Implement the next task", "pending"),
      ],
      [
        todo("1", "Finished earlier work", "completed"),
        todo("r1", "Verified earlier work", "completed"),
      ]
    )
  );

  assert.deepEqual(todos, [
    todo("1", "Inspect the next task", "in_progress"),
    todo("2", "Implement the next task", "pending"),
  ]);
});

test("a fresh plan still cannot begin with completed todos", async () => {
  await rejectsTransition(
    [todo("1", "Unstarted work", "completed")],
    [todo("old", "Finished earlier work", "completed")]
  );
});

test("validateTodos rejects duplicate IDs", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos([
      todo("1", "First task", "pending"),
      { id: " 1 ", content: "Second task", status: "pending" },
    ])
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos does not use content as identity", async () => {
  const todos = await Effect.runPromise(
    validateTodos([
      todo("1", "Shared description", "in_progress"),
      todo("2", "Shared description", "pending"),
    ])
  );

  assert.equal(todos.length, 2);
});

test("validateTodos allows content changes without changing identity", async () => {
  const pending = await Effect.runPromise(
    validateTodos(
      [todo("1", "Inspect todowrite validation", "pending")],
      [todo("1", "Inspect implementation", "pending")]
    )
  );
  const active = await Effect.runPromise(
    validateTodos(
      [todo("1", "Inspect ID-based validation", "in_progress")],
      [todo("1", "Inspect implementation", "in_progress")]
    )
  );

  assert.equal(pending[0]?.content, "Inspect todowrite validation");
  assert.equal(active[0]?.content, "Inspect ID-based validation");
});

test("validateTodos allows replanning future pending items", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [
        todo("1", "Inspect ID-based validation", "in_progress"),
        todo("4", "Add focused regression coverage", "pending"),
        todo("2", "Implement lifecycle validation", "pending"),
      ],
      [
        todo("1", "Inspect implementation", "in_progress"),
        todo("2", "Implement old approach", "pending"),
        todo("3", "Test old approach", "pending"),
      ]
    )
  );

  assert.deepEqual(todos, [
    todo("1", "Inspect ID-based validation", "in_progress"),
    todo("4", "Add focused regression coverage", "pending"),
    todo("2", "Implement lifecycle validation", "pending"),
  ]);
});

test("validateTodos allows removing pending items", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [todo("1", "Active work", "in_progress")],
      [
        todo("1", "Active work", "in_progress"),
        todo("2", "Future work", "pending"),
      ]
    )
  );

  assert.deepEqual(todos, [todo("1", "Active work", "in_progress")]);
});

test("validateTodos rejects removing an in-progress item", async () => {
  await rejectsTransition(
    [todo("2", "Future work", "pending")],
    [
      todo("1", "Active work", "in_progress"),
      todo("2", "Future work", "pending"),
    ]
  );
});

test("validateTodos rejects clearing while an item is in progress", async () => {
  await rejectsTransition([], [todo("1", "Active work", "in_progress")]);
});

test("validateTodos allows clearing when no item is in progress", async () => {
  const pending = await Effect.runPromise(
    validateTodos([], [todo("1", "Future work", "pending")])
  );
  const completed = await Effect.runPromise(
    validateTodos([], [todo("1", "Finished work", "completed")])
  );

  assert.deepEqual(pending, []);
  assert.deepEqual(completed, []);
});

test("validateTodos keeps completed items while the list remains active", async () => {
  await rejectsTransition(
    [todo("2", "Active work", "in_progress")],
    [
      todo("1", "Finished work", "completed"),
      todo("2", "Active work", "in_progress"),
    ]
  );
});

test("validateTodos allows completing one item and starting the next", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [
        todo("1", "First", "completed"),
        todo("2", "Second", "in_progress"),
      ],
      [todo("1", "First", "in_progress"), todo("2", "Second", "pending")]
    )
  );

  assert.deepEqual(todos, [
    todo("1", "First", "completed"),
    todo("2", "Second", "in_progress"),
  ]);
});

test("validateTodos rejects multiple in-progress items", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos([
      todo("1", "First", "in_progress"),
      todo("2", "Second", "in_progress"),
    ])
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos rejects malformed runtime input", async () => {
  const exit = await Effect.runPromiseExit(validateTodos([null]));
  assert.equal(Exit.isFailure(exit), true);
});

test("stored snapshots enforce the same identity, size, and status limits", () => {
  assert.equal(
    decodeStoredTodos(
      Array.from({ length: 21 }, (_, index) => ({
        id: String(index + 1),
        content: "task",
        status: "pending",
      }))
    ),
    undefined
  );
  assert.equal(
    decodeStoredTodos([
      todo("1", "first", "pending"),
      todo("1", "second", "pending"),
    ]),
    undefined
  );
  assert.equal(
    decodeStoredTodos([{ id: "1", content: "x".repeat(201), status: "pending" }]),
    undefined
  );
  assert.equal(
    decodeStoredTodos([
      todo("1", "first", "in_progress"),
      todo("2", "second", "in_progress"),
    ]),
    undefined
  );
  assert.equal(
    decodeStoredTodos([{ id: "1", content: "   ", status: "pending" }]),
    undefined
  );
});

test("stored snapshots normalize values before restoring", () => {
  assert.deepEqual(
    decodeStoredTodos([
      { id: " 1 ", content: "  Restore me  ", status: "pending" },
    ]),
    [todo("1", "Restore me", "pending")]
  );
});

test("legacy stored snapshots receive stable restoration IDs", () => {
  assert.deepEqual(
    decodeStoredTodos([{ content: "Restore me", status: "in_progress" }]),
    [todo("1", "Restore me", "in_progress")]
  );
});

test("IDs are limited to 50 Unicode characters", async () => {
  const accepted = await Effect.runPromise(
    validateTodos([
      { id: "x".repeat(49) + "😀", content: "task", status: "pending" },
    ])
  );
  assert.equal([...accepted[0]!.id].length, 50);

  const rejected = await Effect.runPromiseExit(
    validateTodos([
      { id: "x".repeat(50) + "😀", content: "task", status: "pending" },
    ])
  );
  assert.equal(Exit.isFailure(rejected), true);
});

test("runtime length matches JSON Schema Unicode semantics", async () => {
  const accepted = await Effect.runPromise(
    validateTodos([
      { id: "1", content: "x".repeat(199) + "😀", status: "pending" },
    ])
  );
  assert.equal([...accepted[0]!.content].length, 200);

  const rejected = await Effect.runPromiseExit(
    validateTodos([
      { id: "1", content: "x".repeat(200) + "😀", status: "pending" },
    ])
  );
  assert.equal(Exit.isFailure(rejected), true);
});

test("schema requires IDs and matches runtime content limits", () => {
  const todosSchema = TodoWriteParams.properties.todos as unknown as {
    items: {
      required: string[];
      properties: {
        id: { minLength: number; maxLength: number; pattern: string };
        content: {
          minLength: number;
          maxLength: number;
          pattern: string;
        };
      };
    };
  };
  const itemSchema = todosSchema.items;
  assert.ok(itemSchema.required.includes("id"));
  assert.equal(itemSchema.properties.id.minLength, 1);
  assert.equal(itemSchema.properties.id.maxLength, 50);
  assert.equal(new RegExp(itemSchema.properties.id.pattern).test("   "), false);

  const contentSchema = itemSchema.properties.content;
  assert.equal(contentSchema.minLength, 1);
  assert.equal(contentSchema.maxLength, 200);
  assert.equal(new RegExp(contentSchema.pattern).test("   "), false);
  assert.equal(new RegExp(contentSchema.pattern).test(" task "), true);
});
