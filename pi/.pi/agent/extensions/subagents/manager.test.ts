/**
 * End-to-end smoke tests for manager behavior through a real ManagedRuntime.
 * The registry uses a scripted Pi backend so lifecycle tests do not require
 * provider credentials or make network calls.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const piBackend = makeStubBackend({
    backend: "pi",
    defaultModelLabel: "pi/test-model",
    contextWindow: 128_000,
    toolName: "bash",
    cadenceMs: 30,
  });
  return new Map<BackendName, SubagentBackend>([[piBackend.name, piBackend]]);
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("Pi subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(runtime, manager.spawn("pi", task("Say hello")));
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "pi");

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.equal(done?.status, "done");
    assert.match(done?.finalText ?? "", /\[stub:pi\] completed: Say hello/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("failed Pi subagents settle as unconsumed errors", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("FAIL: blow up please")),
    );
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.match(manager.view.get(snap.id)?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running Pi subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
  });
});

test("the concurrency cap rejects a fifth running Pi subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("idle Pi subagents can start another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.match(manager.view.get(snap.id)?.finalText ?? "", /Second turn/);
  });
});
