import assert from "node:assert/strict";
import test from "node:test";
import {
  createThrottledPublisher,
  toBackgroundTerminalsState,
} from "./src/dashboard.ts";
import type { TerminalSnapshot } from "./src/domain.ts";

function snap(over: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: "t1",
    command: "pnpm dev",
    title: "dev",
    cwd: "/repo",
    pid: 42,
    status: "running",
    createdAt: 1,
    stdout: { text: "secret output", totalBytes: 13, truncatedBytes: 0, spillPath: "/tmp/t1.stdout.log" },
    stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
    ...over,
  } as TerminalSnapshot;
}

test("projection keeps metadata and drops output text", () => {
  const state = toBackgroundTerminalsState([snap(), snap({ id: "t2", status: "done", exitCode: 0 })]);
  assert.equal(state.running, 1);
  assert.equal(state.terminals.length, 2);
  assert.equal(state.terminals[0].stdout.spillPath, "/tmp/t1.stdout.log");
  assert.equal(JSON.stringify(state).includes("secret output"), false);
  assert.equal(state.terminals[1].exitCode, 0);
});

test("publisher coalesces bursts and skips unchanged payloads", () => {
  const published: unknown[] = [];
  const timers: Array<() => void> = [];
  const pub = createThrottledPublisher((s) => published.push(s), 250, (fn) => timers.push(fn));
  pub.request(() => [snap()]);
  pub.request(() => [snap()]);
  assert.equal(timers.length, 1);
  timers.shift()!();
  assert.equal(published.length, 1);
  pub.request(() => [snap()]);
  timers.shift()!();
  assert.equal(published.length, 1, "unchanged state is not republished");
  pub.force(() => [snap()]);
  assert.equal(published.length, 2, "force republishes");
});
