import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/**
 * Default retention budgets (in characters) for captured subprocess output.
 * Retention is bounded by these constants rather than by output length; the
 * child is still drained past the budget so it cannot block on full pipes.
 */
export const MAX_STDOUT_CHARS = 256_000;
export const MAX_STDERR_CHARS = 64_000;

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
  /**
   * True when the command exceeded its timeout. A timed-out result carries
   * whatever partial output arrived in time and must never be reported as a
   * clean or empty result.
   */
  timedOut?: boolean;
  /** True when retained output was capped at its budget. */
  truncated?: boolean;
}

export interface CommandRunOptions {
  maxStdoutChars?: number;
  maxStderrChars?: number;
}

interface CommandRunnerShape {
  run(
    command: string,
    args: string[],
    cwd: string,
    timeout: number,
    options?: CommandRunOptions,
  ): Effect.Effect<CommandResult>;
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  CommandRunnerShape
>()("git-info/CommandRunner") {}

function appendCommandFailure(stderr: string, command: string, error: Error) {
  const failure = `Failed to run ${command}: ${error.message}`;
  return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

function capFailureMessage(value: string, limit: number) {
  if (value.length <= limit) return { truncated: false, value };
  return {
    truncated: true,
    value: `… earlier output truncated …\n${value.slice(-limit)}`,
  };
}

/** Append a chunk without exceeding the retention budget. */
function appendBounded(current: string, chunk: string, limit: number) {
  if (chunk.length === 0) return { truncated: false, value: current };
  const room = limit - current.length;
  if (room <= 0) return { truncated: true, value: current };
  if (chunk.length <= room) {
    return { truncated: false, value: current + chunk };
  }
  // Never split a UTF-16 surrogate pair at the truncation boundary.
  let end = room;
  if (
    end < chunk.length &&
    end > 0 &&
    chunk.charCodeAt(end - 1) >= 0xd800 &&
    chunk.charCodeAt(end - 1) <= 0xdbff &&
    chunk.charCodeAt(end) >= 0xdc00 &&
    chunk.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return { truncated: true, value: current + chunk.slice(0, end) };
}

/** True when a result arrived after its timeout with partial output at best. */
export function isTimeoutResult(result: Pick<CommandResult, "timedOut">) {
  return result.timedOut === true;
}

/** True when a result is missing output: timed out or retention-capped. */
export function isIncompleteResult(
  result: Pick<CommandResult, "timedOut" | "truncated">,
) {
  return result.timedOut === true || result.truncated === true;
}

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;

    return CommandRunner.of({
      run: (command, args, cwd, timeout, options) =>
        Effect.suspend(() => {
          const maxStdout = options?.maxStdoutChars ?? MAX_STDOUT_CHARS;
          const maxStderr = options?.maxStderrChars ?? MAX_STDERR_CHARS;
          let stderr = "";
          let stdout = "";
          let stdoutTruncated = false;
          let stderrTruncated = false;
          const child = ChildProcess.make(command, args, {
            cwd,
            detached: false,
            forceKillAfter: "5 seconds",
            stdin: "ignore",
            stderr: "pipe",
            stdout: "pipe",
          });

          return Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(child);
              const [, , code] = yield* Effect.all(
                [
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.sync(() => {
                      if (!stdoutTruncated) {
                        const appended = appendBounded(
                          stdout,
                          chunk,
                          maxStdout,
                        );
                        stdout = appended.value;
                        stdoutTruncated = appended.truncated;
                      }
                    }),
                  ),
                  Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
                    Effect.sync(() => {
                      if (!stderrTruncated) {
                        const appended = appendBounded(
                          stderr,
                          chunk,
                          maxStderr,
                        );
                        stderr = appended.value;
                        stderrTruncated = appended.truncated;
                      }
                    }),
                  ),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return {
                code: Number(code),
                stderr,
                stdout,
                timedOut: false,
                truncated: stdoutTruncated || stderrTruncated,
              };
            }),
          ).pipe(
            // Interrupting the scoped effect runs its finalizers, which kill
            // the child through the existing scoped process API.
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.succeed({
                  code: -1,
                  stderr,
                  stdout,
                  timedOut: true,
                  truncated: stdoutTruncated || stderrTruncated,
                }),
            }),
            Effect.catch((error) => {
              const failure = capFailureMessage(
                appendCommandFailure(stderr, command, error),
                maxStderr,
              );
              return Effect.succeed({
                code: 1,
                stderr: failure.value,
                stdout,
                timedOut: false,
                truncated:
                  stdoutTruncated || stderrTruncated || failure.truncated,
              });
            }),
          );
        }),
    });
  }),
);

export const runCommand = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  options?: CommandRunOptions,
) =>
  Effect.gen(function* () {
    const commands = yield* CommandRunner;
    return yield* commands.run(command, args, cwd, timeout, options);
  });
