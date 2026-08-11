import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./src/domain.ts";
import { buildTranscriptLines } from "./src/ui/transcript.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

function createSnapshot(): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "pi",
    title: "review",
    prompt: "Review the project",
    cwd: "/tmp/project",
    status: "running",
    createdAt: 0,
    meta: { backend: "pi" },
    usage: {},
    transcript: [
      {
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            toolId: "tool-1",
            name: "read",
            argsPreview: '{"path":"/tmp/project/src/app.ts"}',
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: "tool-1",
        name: "read",
        isError: false,
        outputPreview: "export const answer = 42;\nmore output",
      },
    ],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 1,
  };
}

test("renders completed tools as compact rows with a useful preview", () => {
  const lines = buildTranscriptLines(createSnapshot(), 80, theme);

  assert.deepEqual(lines, [
    "✓ read  /tmp/project/src/app.ts",
    "  ↳ export const answer = 42;",
  ]);
});

test("renders conversation sections and removes common markdown noise", () => {
  const snapshot = createSnapshot();
  const lines = buildTranscriptLines(
    {
      ...snapshot,
      transcript: [
        { kind: "user", text: "Inspect **two files**." },
        {
          kind: "assistant",
          parts: [
            {
              type: "text",
              text: "## Summary\n\n- Read `one.ts`\n- Read **two.ts**\n\n---",
            },
          ],
        },
      ],
    },
    80,
    theme,
  );

  assert.deepEqual(lines, [
    "│ Inspect two files.",
    "",
    "  ◆ Summary",
    "",
    "  • Read one.ts",
    "  • Read two.ts",
    "",
    `  ${"─".repeat(78)}`,
  ]);
});
