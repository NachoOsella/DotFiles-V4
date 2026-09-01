import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSessionFiles } from "./discovery.ts";

test("discoverSessionFiles reads lightweight session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-stats-discovery-"));
  try {
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const sessionPath = join(projectDir, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          timestamp: "2026-01-02T03:04:05.000Z",
          cwd: "/workspace/project",
          parentSession: "/sessions/parent.jsonl",
        }),
        JSON.stringify({ type: "session_info", name: "subagent: tester" }),
        JSON.stringify({ type: "message", message: { role: "user" } }),
      ].join("\n"),
    );

    assert.deepEqual(await discoverSessionFiles(root), [
      {
        path: sessionPath,
        cwd: "/workspace/project",
        name: "subagent: tester",
        parentSessionPath: "/sessions/parent.jsonl",
        created: new Date("2026-01-02T03:04:05.000Z"),
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
