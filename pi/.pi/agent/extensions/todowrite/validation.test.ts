import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Exit } from "effect";
import { validateTodos } from "./validation.ts";

test("validateTodos trims content and preserves valid state", async () => {
  const todos = await Effect.runPromise(
    validateTodos([
      { content: "  Inspect implementation  ", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ]),
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
    ]),
  );

  assert.equal(Exit.isFailure(exit), true);
});

test("validateTodos rejects malformed runtime input", async () => {
  const exit = await Effect.runPromiseExit(validateTodos([null]));
  assert.equal(Exit.isFailure(exit), true);
});
