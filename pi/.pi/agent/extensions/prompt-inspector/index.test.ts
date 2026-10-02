import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("inspect_prompt uses run resources and clears them on session replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prompt-inspector-"));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("./index.ts", import.meta.url)),
    ],
  });
  let session:
    Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(directory),
      tools: [],
    }));
    await session.bindExtensions({
      onError: (error) => assert.fail(error.error),
    });
    const runner = session.extensionRunner;
    const tool = runner.getToolDefinition("inspect_prompt")!;
    const inspect = async () => {
      const result = await tool.execute(
        "inspect",
        {},
        undefined,
        undefined,
        runner.createToolContext("inspect", undefined),
      );
      return result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
    };
    assert.match(await inspect(), /Skills: n\/a -- context files: n\/a/);
    await runner.emitBeforeAgentStart("Test", undefined, {
      cwd: directory,
      skills: [
        {
          name: "test-skill",
          description: "Test skill",
          filePath: "/tmp/test/SKILL.md",
          baseDir: "/tmp/test",
          sourceInfo: {
            path: "/tmp/test/SKILL.md",
            source: "user",
            scope: "user",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      contextFiles: [
        { path: "/tmp/AGENTS.md", content: "Project instructions" },
      ],
    });
    assert.match(await inspect(), /Skills: 1 -- context files: 1/);
    assert.match(await inspect(), /Active tools: 0/);
    await runner.emit({ type: "session_start", reason: "new" });
    assert.match(await inspect(), /Skills: n\/a -- context files: n\/a/);
  } finally {
    if (session) {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
