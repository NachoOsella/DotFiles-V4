import assert from "node:assert/strict";
import test from "node:test";
import { formatModelWithThinking } from "./src/domain.ts";
import {
  preserveScrolledOffset,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("formats the model together with the thinking level", () => {
  assert.equal(
    formatModelWithThinking({
      modelLabel: "openai/gpt-test",
      thinkingLevel: "high",
    }),
    "openai/gpt-test (high)",
  );
  assert.equal(formatModelWithThinking({ modelLabel: "openai/gpt-test" }), "openai/gpt-test");
});

test("keeps scrolled transcript content anchored as streamed output grows", () => {
  const previousLineCount = 100;
  const nextLineCount = 125;
  const previousOffset = 30;
  const nextOffset = preserveScrolledOffset(
    previousOffset,
    previousLineCount,
    nextLineCount,
  );

  assert.equal(nextOffset, 55);
  assert.equal(previousLineCount - previousOffset, nextLineCount - nextOffset);
  assert.equal(preserveScrolledOffset(0, previousLineCount, nextLineCount), 0);
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
