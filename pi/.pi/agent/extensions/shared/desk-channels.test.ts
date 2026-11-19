import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyBackgroundTerminalsState,
  isBackgroundTerminalsState,
  isFastModeState,
} from "./dashboard-state.ts";

const stream = { totalBytes: 10, truncatedBytes: 0, spillPath: "/tmp/x.log" };
const terminal = {
  id: "t1",
  title: "dev server",
  command: "pnpm dev",
  cwd: "/repo",
  status: "running",
  createdAt: 1,
  stdout: stream,
  stderr: { totalBytes: 0, truncatedBytes: 0 },
};

test("background terminals state guard accepts valid snapshots", () => {
  assert.equal(isBackgroundTerminalsState(emptyBackgroundTerminalsState()), true);
  assert.equal(isBackgroundTerminalsState({ running: 1, terminals: [terminal] }), true);
});

test("background terminals state guard rejects malformed snapshots", () => {
  assert.equal(isBackgroundTerminalsState(null), false);
  assert.equal(isBackgroundTerminalsState({ running: 1 }), false);
  assert.equal(
    isBackgroundTerminalsState({ running: 1, terminals: [{ ...terminal, stdout: {} }] }),
    false,
  );
});

test("fast mode guard", () => {
  assert.equal(isFastModeState({ active: true }), true);
  assert.equal(isFastModeState({ active: "yes" }), false);
});
