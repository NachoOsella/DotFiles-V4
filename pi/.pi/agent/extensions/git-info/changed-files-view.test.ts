import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer } from "effect";
import {
  isChangedFilesLoadIssue,
  loadChangedFiles,
} from "./src/changed-files-view.ts";
import { CommandRunner, type CommandResult } from "./src/process.ts";

type Handler = (command: string, args: string[]) => CommandResult;

const ok = (
  stdout = "",
  extra: Partial<CommandResult> = {},
): CommandResult => ({
  code: 0,
  stderr: "",
  stdout,
  timedOut: false,
  truncated: false,
  ...extra,
});

const makeHandler =
  (overrides: {
    root?: CommandResult;
    status?: CommandResult;
    head?: CommandResult;
    diff?: CommandResult;
    stat?: CommandResult;
  }): Handler =>
  (command, args) => {
    if (command !== "git") throw new Error(`unexpected command ${command}`);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return overrides.root ?? ok("/repo\n");
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return overrides.head ?? ok("abc123\n");
    }
    if (args[0] === "status") {
      return overrides.status ?? ok(" M file.txt\0");
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return overrides.stat ?? ok("3\t1\tfile.txt\n");
    }
    if (args[0] === "diff") {
      return overrides.diff ?? ok("diff --git a/file.txt b/file.txt\n+added\n");
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };

const provideFake = (handler: Handler) =>
  Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: (command, args) => Effect.succeed(handler(command, args)),
    }),
  );

const load = (handler: Handler, cwd = "/repo") =>
  Effect.runPromise(
    Effect.provide(loadChangedFiles(cwd), provideFake(handler)),
  );

test("returns null for a definitive non-repository error", async () => {
  const result = await load(
    makeHandler({
      root: {
        code: 128,
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git",
        stdout: "",
      },
    }),
  );

  assert.equal(result, null);
});

test("reports timeouts while locating the repository instead of a clean miss", async () => {
  const result = await load(makeHandler({ root: ok("", { timedOut: true }) }));

  assert.ok(
    isChangedFilesLoadIssue(result),
    "a timeout should surface as a load issue, not null",
  );
  assert.equal(result.kind, "timed-out");
});

test("reports spawn failures while locating the repository", async () => {
  const result = await load(
    makeHandler({
      root: {
        code: 1,
        stderr: "Failed to run git: spawn git ENOENT",
        stdout: "",
      },
    }),
  );

  assert.ok(isChangedFilesLoadIssue(result));
  assert.equal(result.kind, "failed");
});

test("reports git status timeouts instead of partial file lists", async () => {
  const result = await load(
    makeHandler({ status: ok(" M file.txt\0", { timedOut: true }) }),
  );

  assert.ok(isChangedFilesLoadIssue(result));
  assert.equal(result.kind, "timed-out");
});

test("reports truncated status output as incomplete", async () => {
  const result = await load(
    makeHandler({ status: ok(" M file.txt\0", { truncated: true }) }),
  );

  assert.ok(isChangedFilesLoadIssue(result));
  assert.equal(result.kind, "truncated");
});

test("treats status failures as errors rather than clean trees", async () => {
  const result = await load(
    makeHandler({
      status: {
        code: 1,
        stderr: "fatal: unable to read status",
        stdout: "",
      },
    }),
  );

  assert.ok(isChangedFilesLoadIssue(result));
  assert.equal(result.kind, "failed");
});

test("marks timed-out diffs distinctly", async () => {
  const result = await load(
    makeHandler({ diff: ok("partial", { timedOut: true }) }),
  );

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.diffTimedOut, true);
  assert.match(result[0]!.diff.join("\n"), /timed out/i);
});

test("marks truncated diffs explicitly", async () => {
  const result = await load(
    makeHandler({ diff: ok("+line\n", { truncated: true }) }),
  );

  assert.ok(Array.isArray(result));
  assert.equal(result[0]!.diffTruncated, true);
  assert.match(result[0]!.diff.join("\n"), /truncat/i);
});

test("reports empty diffs as having no textual diff", async () => {
  const result = await load(makeHandler({ diff: ok("") }));

  assert.ok(Array.isArray(result));
  assert.equal(result[0]!.diffTimedOut ?? false, false);
  assert.equal(result[0]!.diffTruncated ?? false, false);
  assert.match(result[0]!.diff.join("\n"), /no textual diff/i);
});

test("truncates very long diffs at the line budget", async () => {
  const result = await load(
    makeHandler({ diff: ok(`${"x\n".repeat(20_005)}`) }),
  );

  assert.ok(Array.isArray(result));
  assert.equal(result[0]!.diffTruncated, true);
  assert.ok(result[0]!.diff.length <= 20_001);
  assert.match(result[0]!.diff.at(-1) ?? "", /truncat/i);
});

test("sanitizes control characters in paths and diffs", async () => {
  const result = await load(
    makeHandler({
      status: ok(" M \x1b[31mred.txt\0"),
      diff: ok("+\x1b[2Jevil\n+\u0007beep\n"),
    }),
  );

  assert.ok(Array.isArray(result));
  const file = result[0]!;
  assert.match(file.path, /red\.txt/);
  for (const value of [file.name, file.path, ...file.diff]) {
    assert.ok(
      !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value),
      `output should not contain raw control characters: ${JSON.stringify(value)}`,
    );
  }
  assert.ok(!file.path.includes("\x1b"));
});

test("parses binary numstat entries without NaN counts", async () => {
  const result = await load(makeHandler({ stat: ok("-\t-\tbinary.dat\n") }));

  assert.ok(Array.isArray(result));
  assert.equal(result[0]!.additions, null);
  assert.equal(result[0]!.deletions, null);
});
