import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { TodoWriteParams } from "./schema.ts";
import { decodeStoredTodos, validateTodos } from "./validation.ts";

test("validateTodos trims content and preserves valid state", async () => {
  const todos = await Effect.runPromise(
    validateTodos([
      { content: "  Inspect implementation  ", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ])
  );

  assert.deepEqual(todos, [
    { content: "Inspect implementation", status: "in_progress" },
    { content: "Run tests", status: "pending" },
  ]);
});

test("validateTodos accepts the normal pending to completed lifecycle", async () => {
  const initial = await Effect.runPromise(
    validateTodos([{ content: "Implement feature", status: "pending" }])
  );
  const started = await Effect.runPromise(
    validateTodos(
      [{ content: "Implement feature", status: "in_progress" }],
      initial
    )
  );
  const completed = await Effect.runPromise(
    validateTodos(
      [{ content: "Implement feature", status: "completed" }],
      started
    )
  );

  assert.deepEqual(completed, [
    { content: "Implement feature", status: "completed" },
  ]);
});

test("validateTodos rejects pending items completed without starting", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos(
      [{ content: "Implement feature", status: "completed" }],
      [{ content: "Implement feature", status: "pending" }]
    )
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos rejects completing a renamed pending item", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos(
      [{ content: "Implement the revised feature", status: "completed" }],
      [{ content: "Implement the original feature", status: "pending" }]
    )
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos allows completing one item and starting the next", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [
        { content: "First", status: "completed" },
        { content: "Second", status: "in_progress" },
      ],
      [
        { content: "First", status: "in_progress" },
        { content: "Second", status: "pending" },
      ]
    )
  );

  assert.deepEqual(todos, [
    { content: "First", status: "completed" },
    { content: "Second", status: "in_progress" },
  ]);
});

test("validateTodos rejects multiple in-progress items", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos([
      { content: "First", status: "in_progress" },
      { content: "Second", status: "in_progress" },
    ])
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos rejects duplicate content used for identity", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos([
      { content: "Same task", status: "pending" },
      { content: "  Same task  ", status: "in_progress" },
    ])
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos allows replanning future pending items", async () => {
  const todos = await Effect.runPromise(
    validateTodos(
      [
        { content: "Investigate the new approach", status: "pending" },
        { content: "Add coverage for the new approach", status: "pending" },
      ],
      [
        { content: "Investigate the old approach", status: "pending" },
        { content: "Implement the old approach", status: "pending" },
      ]
    )
  );

  assert.deepEqual(todos, [
    { content: "Investigate the new approach", status: "pending" },
    { content: "Add coverage for the new approach", status: "pending" },
  ]);
});

test("validateTodos rejects completed items that regress", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos(
      [{ content: "Finished work", status: "pending" }],
      [{ content: "Finished work", status: "completed" }]
    )
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos allows intentionally clearing the list", async () => {
  const todos = await Effect.runPromise(
    validateTodos([], [{ content: "Active work", status: "in_progress" }])
  );

  assert.deepEqual(todos, []);
});

test("validateTodos rejects malformed runtime input", async () => {
  const exit = await Effect.runPromiseExit(validateTodos([null]));
  assert.equal(Exit.isFailure(exit), true);
});

test("stored snapshots enforce the same size and status limits", () => {
  assert.equal(
    decodeStoredTodos(
      Array.from({ length: 21 }, () => ({
        content: "task",
        status: "pending",
      }))
    ),
    undefined
  );
  assert.equal(
    decodeStoredTodos([{ content: "x".repeat(201), status: "pending" }]),
    undefined
  );
  assert.equal(
    decodeStoredTodos([
      { content: "first", status: "in_progress" },
      { content: "second", status: "in_progress" },
    ]),
    undefined
  );
  assert.equal(
    decodeStoredTodos([{ content: "   ", status: "pending" }]),
    undefined
  );
});

test("stored snapshots normalize content before restoring", () => {
  assert.deepEqual(
    decodeStoredTodos([{ content: "  Restore me  ", status: "pending" }]),
    [{ content: "Restore me", status: "pending" }]
  );
});

test("runtime length matches JSON Schema Unicode semantics", async () => {
  const accepted = await Effect.runPromise(
    validateTodos([{ content: "x".repeat(199) + "😀", status: "pending" }])
  );
  assert.equal([...accepted[0]!.content].length, 200);

  const rejected = await Effect.runPromiseExit(
    validateTodos([{ content: "x".repeat(200) + "😀", status: "pending" }])
  );
  assert.equal(Exit.isFailure(rejected), true);
});

test("schema rejects whitespace-only content and matches runtime limits", () => {
  const todosSchema = TodoWriteParams.properties.todos as unknown as {
    items: {
      properties: {
        content: {
          minLength: number;
          maxLength: number;
          pattern: string;
        };
      };
    };
  };
  const contentSchema = todosSchema.items.properties.content;
  assert.equal(contentSchema.minLength, 1);
  assert.equal(contentSchema.maxLength, 200);
  assert.equal(new RegExp(contentSchema.pattern).test("   "), false);
  assert.equal(new RegExp(contentSchema.pattern).test(" task "), true);
});
