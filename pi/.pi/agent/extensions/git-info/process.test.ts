import assert from "node:assert/strict";
import test from "node:test";
import { Fiber } from "effect";
import {
  MAX_STDERR_CHARS,
  MAX_STDOUT_CHARS,
  runCommand,
} from "./src/process.ts";
import { createRuntime } from "./src/runtime.ts";

const runtime = createRuntime();

test.after(async () => {
  await runtime.dispose();
});

const runNode = (source: string, timeout = 1_000) =>
  runtime.runPromise(
    runCommand(
      process.execPath,
      ["--input-type=module", "--eval", source],
      process.cwd(),
      timeout,
    ),
  );

const forkNode = (source: string, timeout: number) =>
  runtime.runFork(
    runCommand(
      process.execPath,
      ["--input-type=module", "--eval", source],
      process.cwd(),
      timeout,
    ),
  );

test("captures output and tolerates command failures", async () => {
  const success = await runNode(
    'process.stdout.write("out"); process.stderr.write("err")',
  );
  assert.deepEqual(success, {
    code: 0,
    stderr: "err",
    stdout: "out",
    timedOut: false,
    truncated: false,
  });

  const failure = await runNode("process.exitCode = 7");
  assert.equal(failure.code, 7);
  assert.equal(failure.timedOut, false);
});

test("renders platform failures without making callers handle them", async () => {
  const command = "git-info-command-that-does-not-exist";
  const result = await runtime.runPromise(
    runCommand(command, [], process.cwd(), 1_000),
  );

  assert.equal(result.code, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, new RegExp(`Failed to run ${command}:`));
  assert.match(result.stderr, /NotFound|not found|ENOENT/i);
});

test("reports command timeouts as failures", async () => {
  const result = await runNode("setTimeout(() => {}, 1_000)", 20);
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
});

test("keeps partial output when a command times out", async () => {
  const result = await runNode(
    'process.stdout.write("partial"); setTimeout(() => {}, 1_000)',
    50,
  );

  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /partial/);
});

test("bounds large stdout and stderr instead of accumulating them", async () => {
  const result = await runNode(
    'process.stdout.write("x".repeat(2_000_000)); ' +
      'process.stderr.write("y".repeat(500_000));',
    10_000,
  );

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, true);
  assert.ok(
    result.stdout.length <= MAX_STDOUT_CHARS,
    `stdout should stay within ${MAX_STDOUT_CHARS} chars`,
  );
  assert.ok(
    result.stderr.length <= MAX_STDERR_CHARS,
    `stderr should stay within ${MAX_STDERR_CHARS} chars`,
  );
});

test("supports per-command output budgets", async () => {
  const result = await runtime.runPromise(
    runCommand(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'process.stdout.write("0123456789ABCDEF")',
      ],
      process.cwd(),
      1_000,
      { maxStdoutChars: 10 },
    ),
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "0123456789");
  assert.equal(result.truncated, true);
});

test("keeps multi-byte characters intact when truncating", async () => {
  const result = await runNode(
    'process.stdout.write("💖".repeat(200_000))',
    10_000,
  );

  assert.equal(result.truncated, true);
  assert.ok(
    result.stdout.length <= MAX_STDOUT_CHARS,
    `stdout should stay within ${MAX_STDOUT_CHARS} chars`,
  );
  assert.ok(
    [...result.stdout].every((char) => char === "💖"),
    "truncated output should contain only complete characters",
  );
});

test("supports cancellation while a command is starting", async () => {
  const fiber = await forkNode("setTimeout(() => {}, 10_000)", 30_000);
  await runtime.runPromise(Fiber.interrupt(fiber));
});

test("supports cancellation while reading command output", async () => {
  const fiber = await forkNode(
    'setInterval(() => process.stdout.write("x".repeat(4096)), 1)',
    30_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));

  const started = Date.now();
  await runtime.runPromise(Fiber.interrupt(fiber));
  assert.ok(
    Date.now() - started < 10_000,
    "interruption should settle promptly",
  );
});
