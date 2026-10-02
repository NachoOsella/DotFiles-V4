import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import backgroundTerminals from "./index.ts";

test("bg_status returns both streams to scripts before consuming the completion", async () => {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, () => void | Promise<void>>();
  const delivered: unknown[] = [];
  backgroundTerminals({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand() {},
    registerMessageRenderer() {},
    on: (name: string, handler: () => void | Promise<void>) =>
      handlers.set(name, handler),
    sendMessage: (message: unknown) => delivered.push(message),
  } as unknown as ExtensionAPI);
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => false,
  } as never;
  try {
    const start = await tools.get("bg_start")!.execute(
      "start",
      {
        command: `node -e 'process.stdout.write("review-stdout"); process.stderr.write("review-stderr")'`,
        title: "Status test",
      },
      undefined,
      undefined,
      context,
    );
    const { id } = start.details as { id: string };
    const statusTool = tools.get("bg_status")!;
    let status = await statusTool.execute(
      "status",
      { id },
      undefined,
      undefined,
      context,
    );
    const deadline = Date.now() + 5_000;
    while ((status.details as { status: string }).status === "running") {
      assert.ok(Date.now() < deadline, "background command did not finish");
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await statusTool.execute(
        "status",
        { id },
        undefined,
        undefined,
        context,
      );
    }
    assert.ok(statusTool.outputSchema);
    const output = status.structuredContent as {
      status: string;
      stdout: {
        text: string;
        truncated: boolean;
        fullOutputPath?: string;
      };
      stderr: {
        text: string;
        truncated: boolean;
        fullOutputPath?: string;
      };
    };
    assert.equal(output.status, "done");
    assert.equal(output.stdout.text, "review-stdout");
    assert.equal(output.stderr.text, "review-stderr");
    assert.equal(output.stdout.truncated, false);
    assert.equal(output.stderr.truncated, false);
    assert.ok(output.stdout.fullOutputPath);
    assert.ok(output.stderr.fullOutputPath);
    await handlers.get("agent_settled")!();
    assert.deepEqual(delivered, []);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});
