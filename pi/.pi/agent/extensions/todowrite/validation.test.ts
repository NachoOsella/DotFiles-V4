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

test("validateTodos rejects multiple in-progress items", async () => {
  const exit = await Effect.runPromiseExit(
    validateTodos([
      { content: "First", status: "in_progress" },
      { content: "Second", status: "in_progress" },
    ])
  );

  assert.equal(Exit.isFailure(exit), true);
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
