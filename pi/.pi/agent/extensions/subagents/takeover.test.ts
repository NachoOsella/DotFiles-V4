import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  formatModelWithThinking,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  countSubagentStates,
  formatActivityStatus,
  subagentDisplayState,
} from "./src/format.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import {
  dashboardNeedsTicker,
  fitScrollWindow,
  preserveScrolledOffset,
  reconcileDashboardSelection,
  SubagentDashboard,
  TakeoverView,
  takeoverNeedsTicker,
  transcriptCacheKey,
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

test("transcript cache identity changes with explicit versions", () => {
  const base = { id: "sa-1", version: 4, transcriptVersion: 10 };
  assert.notEqual(
    transcriptCacheKey(base, 80),
    transcriptCacheKey({ ...base, transcriptVersion: 11 }, 80),
  );
  assert.notEqual(
    transcriptCacheKey({ id: base.id, version: 4 }, 80),
    transcriptCacheKey({ id: base.id, version: 5 }, 80),
  );
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

// --- P02 component render regression tests ------------------------------------

const RENDER_WIDTHS = [0, 1, 2, 8, 12, 20, 40, 80, 120];
const RENDER_HEIGHTS = [1, 3, 5, 8, 24, 40];

function makePlainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as Theme;
}

const DEFAULT_TEST_KEYS: Record<string, string[]> = {
  "tui.select.cancel": ["escape"],
  "tui.select.confirm": ["enter"],
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "app.clear": ["ctrl+c"],
  "app.interrupt": ["escape"],
  "tui.editor.cursorUp": ["ctrl+up"],
  "tui.editor.cursorDown": ["ctrl+down"],
  "tui.editor.pageUp": ["pageup"],
  "tui.editor.pageDown": ["pagedown"],
};

function makeTestKeybindings(overrides: Record<string, string[]> = {}) {
  const mapping = { ...DEFAULT_TEST_KEYS, ...overrides };
  return {
    getKeys: (binding: string) => [...(mapping[binding] ?? [])],
    matches: (data: string, binding: string) =>
      (mapping[binding] ?? []).includes(data),
  } as unknown as KeybindingsManager;
}

let testSnapCounter = 0;

function makeTestSnap(
  overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
  testSnapCounter += 1;
  return {
    id: `sa-${testSnapCounter}`,
    backend: "pi",
    title: "task",
    taskName: "Do the thing",
    role: "worker",
    prompt: "prompt",
    cwd: "/tmp/project",
    status: "running",
    ownedPaths: [],
    createdAt: Date.now() - 60_000,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 1,
    ...overrides,
  };
}

interface FakeSubagentView extends SubagentReadModel {
  aborted: string[];
  sent: Array<{ id: string; text: string }>;
  fire(id?: string): void;
}

function makeFakeView(snaps: SubagentSnapshot[]): FakeSubagentView {
  const all = new Set<() => void>();
  const perId = new Map<string, Set<() => void>>();
  const view: FakeSubagentView = {
    aborted: [],
    sent: [],
    list: () => snaps,
    get: (id: string) => snaps.find((snap) => snap.id === id),
    size: () => snaps.length,
    subscribe: (listener: () => void) => {
      all.add(listener);
      return () => {
        all.delete(listener);
      };
    },
    subscribeTo: (id: string, listener: () => void) => {
      let set = perId.get(id);
      if (!set) {
        set = new Set();
        perId.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    requestSend: (id: string, text: string) => {
      view.sent.push({ id, text });
    },
    requestAbort: (id: string) => {
      view.aborted.push(id);
    },
    requestClose: () => {},
    setOnSettled: () => {},
    fire: (id?: string) => {
      for (const listener of [...all]) listener();
      if (id) {
        for (const listener of [...(perId.get(id) ?? [])]) listener();
      }
    },
  };
  return view;
}

function makeFakeTui(rows: number, onRender?: () => void): TUI {
  return {
    terminal: { rows },
    requestRender: () => {
      onRender?.();
    },
  } as unknown as TUI;
}

function assertRenderContract(
  lines: string[],
  width: number,
  rows: number,
): void {
  if (width <= 0 || rows <= 0) {
    assert.deepEqual(lines, []);
    return;
  }
  assert.ok(
    lines.length <= rows,
    `expected ${lines.length} lines to fit in ${rows} rows`,
  );
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line wider than ${width}: ${JSON.stringify(line)}`,
    );
  }
}

function openDashboard(
  view: FakeSubagentView,
  rows: number,
  selection: DashboardSelection = { index: 0 },
  keybindings: KeybindingsManager = makeTestKeybindings(),
  done: (value: string | null) => void = () => {},
  options?: { hasPendingQuestion?: (id: string) => boolean },
): SubagentDashboard {
  return new SubagentDashboard(
    makeFakeTui(rows),
    makePlainTheme(),
    keybindings,
    view,
    selection,
    done,
    options,
  );
}

test("dashboard render stays within width/height budgets", () => {
  const sets: SubagentSnapshot[][] = [
    [],
    [makeTestSnap({ id: "mx-1" })],
    Array.from({ length: 8 }, (_, index) =>
      makeTestSnap({ id: `mx-${index + 1}` }),
    ),
    Array.from({ length: 64 }, (_, index) =>
      makeTestSnap({ id: `mx-${index + 1}` }),
    ),
  ];
  for (const snaps of sets) {
    for (const rows of RENDER_HEIGHTS) {
      for (const width of RENDER_WIDTHS) {
        const dashboard = openDashboard(makeFakeView(snaps), rows);
        try {
          assertRenderContract(dashboard.render(width), width, rows);
        } finally {
          dashboard.dispose();
        }
      }
    }
  }
});

test("dashboard counts each terminal state in its own bucket", () => {
  const snaps = [
    makeTestSnap({ id: "sa-1", status: "running" }),
    makeTestSnap({ id: "sa-2", status: "running" }),
    makeTestSnap({
      id: "sa-3",
      status: "running",
      queued: [{ text: "later", kind: "follow-up" }],
    }),
    makeTestSnap({ id: "sa-4", status: "done" }),
    makeTestSnap({
      id: "sa-5",
      status: "error",
      lastRun: { id: "r5", agentId: "sa-5", status: "failed", startedAt: 0 },
    }),
    makeTestSnap({
      id: "sa-6",
      status: "error",
      lastRun: {
        id: "r6",
        agentId: "sa-6",
        status: "interrupted",
        startedAt: 0,
      },
    }),
    makeTestSnap({ id: "sa-7", status: "closed" }),
  ];
  const hasPendingQuestion = (id: string) => id === "sa-2";
  assert.deepEqual(countSubagentStates(snaps, hasPendingQuestion), {
    running: 2,
    queued: 1,
    done: 1,
    failed: 1,
    interrupted: 1,
    closed: 1,
  });

  const dashboard = openDashboard(makeFakeView(snaps), 24, { index: 0 }, makeTestKeybindings(), () => {}, {
    hasPendingQuestion,
  });
  try {
    // Narrow renders truncate the summary to the width budget; assert full
    // content at a wide size and the budget at a narrow one.
    assertRenderContract(dashboard.render(80), 80, 24);
    const lines = dashboard.render(120);
    assertRenderContract(lines, 120, 24);
    const summary = lines.find((line) => line.includes("2 running"));
    assert.ok(summary, `expected a summary line: ${JSON.stringify(lines)}`);
    for (const part of [
      "2 running",
      "1 queued",
      "1 done",
      "1 failed",
      "1 interrupted",
      "1 closed",
    ]) {
      assert.ok(
        summary.includes(part),
        `summary should contain ${JSON.stringify(part)}: ${JSON.stringify(summary)}`,
      );
    }
    const body = lines.join("\n");
    assert.ok(body.includes("needs answer"), "question row should be visible");
    assert.ok(body.includes("interrupted"), "interrupted row should be visible");
    assert.ok(body.includes("closed"), "closed row should be visible");
  } finally {
    dashboard.dispose();
  }
});

test("footer activity status uses the same terminal buckets", () => {
  const text = formatActivityStatus(makePlainTheme(), {
    running: 2,
    queued: 1,
    done: 1,
    failed: 1,
    interrupted: 1,
    closed: 1,
  });
  for (const part of [
    "2 running",
    "1 queued",
    "1 done",
    "1 failed",
    "1 interrupted",
    "1 closed",
  ]) {
    assert.ok(text.includes(part), `${part} missing from ${text}`);
  }
  assert.ok(!text.includes("closed done"));
});

test("subagent display states derive from lastRun, queue, and questions", () => {
  const base = makeTestSnap({ status: "error" });
  assert.equal(subagentDisplayState(base), "failed");
  assert.equal(
    subagentDisplayState({
      ...base,
      lastRun: { id: "r", agentId: base.id, status: "interrupted", startedAt: 0 },
    }),
    "interrupted",
  );
  const running = makeTestSnap({ status: "running" });
  assert.equal(subagentDisplayState(running), "running");
  assert.equal(
    subagentDisplayState(running, () => true),
    "needs-answer",
  );
  assert.equal(
    subagentDisplayState({
      ...running,
      queued: [{ text: "x", kind: "steer" }],
    }),
    "queued",
  );
  assert.equal(subagentDisplayState(makeTestSnap({ status: "closed" })), "closed");
  assert.equal(subagentDisplayState(makeTestSnap({ status: "done" })), "done");
});

test("dashboard keeps scroll indicators outside selectable rows", () => {
  const snaps = Array.from({ length: 8 }, (_, index) =>
    makeTestSnap({ id: `sc-${index + 1}`, taskName: `Job ${index + 1}` }),
  );
  for (const index of [0, 7]) {
    const dashboard = openDashboard(makeFakeView(snaps), 8, { index });
    try {
      const lines = dashboard.render(80);
      assertRenderContract(lines, 80, 8);
      const selected = lines.filter((line) => line.includes("❯"));
      assert.equal(selected.length, 1);
      assert.ok(
        selected[0].includes(`sc-${index + 1}`),
        `selected row should show sc-${index + 1}`,
      );
      for (const line of lines) {
        if (line.includes("more")) {
          assert.ok(!line.includes("❯"), "indicator must not replace a row");
          assert.ok(
            !line.includes("sc-"),
            "indicator must not carry an agent id",
          );
        }
      }
      assert.ok(
        lines.some((line) => line.includes(`${index + 1}/8`)),
        "expected a selected-position counter",
      );
    } finally {
      dashboard.dispose();
    }
  }
});

test("borderless dashboard shows a position counter when it fits", () => {
  const snaps = Array.from({ length: 8 }, (_, index) =>
    makeTestSnap({ id: `n${index + 1}`, taskName: `Job ${index + 1}` }),
  );
  const dashboard = openDashboard(makeFakeView(snaps), 5, { index: 7 });
  try {
    const lines = dashboard.render(8);
    assertRenderContract(lines, 8, 5);
    assert.ok(lines.some((line) => line.includes("8/8")), lines.join("\n"));
    assert.ok(lines.some((line) => line.includes("n8")), lines.join("\n"));
  } finally {
    dashboard.dispose();
  }
});

test("dashboard never guesses questions from output text", () => {
  const snaps = [
    makeTestSnap({
      id: "sa-1",
      status: "running",
      finalText: "really? are you sure?",
      transcript: [{ kind: "user", text: "should we stop?" }],
    }),
  ];
  const plain = openDashboard(makeFakeView(snaps), 24);
  try {
    const body = plain.render(80).join("\n");
    assert.ok(body.includes("running"));
    assert.ok(!body.includes("needs answer"));
  } finally {
    plain.dispose();
  }
  const asked = openDashboard(makeFakeView(snaps), 24, { index: 0 }, makeTestKeybindings(), () => {}, {
    hasPendingQuestion: (id) => id === "sa-1",
  });
  try {
    assert.ok(asked.render(80).join("\n").includes("needs answer"));
  } finally {
    asked.dispose();
  }
});

test("dashboard actions and hints follow injected keybindings", () => {
  const snaps = [
    makeTestSnap({ id: "sa-1", status: "running" }),
    makeTestSnap({ id: "sa-2", status: "running" }),
  ];
  const view = makeFakeView(snaps);
  const keybindings = makeTestKeybindings({
    "tui.select.cancel": ["f1"],
    "tui.select.confirm": ["f2"],
    "tui.select.up": ["ctrl+p"],
    "tui.select.down": ["ctrl+n"],
    "app.clear": ["f3"],
  });
  const selection: DashboardSelection = { index: 0 };
  let doneValue: string | null | undefined;
  const dashboard = new SubagentDashboard(
    makeFakeTui(24),
    makePlainTheme(),
    keybindings,
    view,
    selection,
    (value) => {
      doneValue = value;
    },
  );
  try {
    const bottom = dashboard.render(80).at(-1) ?? "";
    assert.ok(bottom.includes("f1"), `hints should show f1: ${bottom}`);
    assert.ok(bottom.includes("f2"), `hints should show f2: ${bottom}`);
    assert.ok(bottom.includes("f3"), `hints should show f3: ${bottom}`);
    assert.ok(!bottom.includes("escape"), "hints must not show remapped keys");

    dashboard.handleInput("x");
    dashboard.handleInput("j");
    dashboard.handleInput("k");
    assert.deepEqual(view.aborted, []);
    assert.equal(selection.index, 0);

    dashboard.handleInput("ctrl+n");
    assert.equal(selection.index, 1);
    dashboard.handleInput("ctrl+p");
    assert.equal(selection.index, 0);

    dashboard.handleInput("f3");
    assert.deepEqual(view.aborted, ["sa-1"]);

    dashboard.handleInput("f2");
    assert.equal(doneValue, "sa-1");
  } finally {
    dashboard.dispose();
  }
});

test("dashboard only ticks while agents are running", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const theme = makePlainTheme();
    const keybindings = makeTestKeybindings();
    let renders = 0;
    const running = new SubagentDashboard(
      makeFakeTui(24, () => {
        renders += 1;
      }),
      theme,
      keybindings,
      makeFakeView([makeTestSnap({ status: "running" })]),
      { index: 0 },
      () => {},
    );
    let settledRenders = 0;
    const settledSnaps = [
      makeTestSnap({ status: "done" }),
      makeTestSnap({ status: "closed" }),
    ];
    const settledView = makeFakeView(settledSnaps);
    const settled = new SubagentDashboard(
      makeFakeTui(24, () => {
        settledRenders += 1;
      }),
      theme,
      keybindings,
      settledView,
      { index: 0 },
      () => {},
    );
    assert.equal(dashboardNeedsTicker(settledSnaps), false);
    mock.timers.tick(3000);
    assert.ok(renders >= 3, `expected ticks, saw ${renders}`);
    assert.equal(settledRenders, 0);

    // A settled agent that restarts resumes ticking through its subscription.
    (settledSnaps[0] as { status: SubagentSnapshot["status"] }).status =
      "running";
    settledView.fire();
    mock.timers.tick(1000);
    assert.ok(settledRenders >= 1, "restarted agent should tick again");

    running.dispose();
    settled.dispose();
    renders = 0;
    settledRenders = 0;
    mock.timers.tick(3000);
    assert.equal(renders, 0);
    assert.equal(settledRenders, 0);
  } finally {
    mock.timers.reset();
  }
});

test("fitScrollWindow always keeps the selection visible within budget", () => {
  assert.deepEqual(fitScrollWindow(0, 5, 0), {
    start: 0,
    size: 0,
    topMore: 0,
    bottomMore: 0,
  });
  assert.deepEqual(fitScrollWindow(3, 5, 0), {
    start: 0,
    size: 3,
    topMore: 0,
    bottomMore: 0,
  });
  for (const count of [1, 2, 5, 8, 64]) {
    for (const cap of [1, 2, 3, 5, 10]) {
      for (const sel of [0, Math.floor(count / 2), count - 1]) {
        const win = fitScrollWindow(count, cap, sel);
        const expectedSize = Math.min(count, cap === 1 ? 1 : cap);
        assert.ok(win.size <= expectedSize, `size for ${count}/${cap}`);
        if (count > 0 && cap > 0) {
          assert.ok(
            sel >= win.start && sel < win.start + win.size,
            `selection ${sel} visible in ${JSON.stringify(win)}`,
          );
        }
        if (cap === 1) {
          // No room for indicator lines; hidden counts are not reported.
          assert.equal(win.topMore, 0);
          assert.equal(win.bottomMore, 0);
          continue;
        }
        if (win.topMore === 0 && win.bottomMore === 0) {
          // No indicators: either nothing is hidden, or the cap is too small
          // to show an indicator alongside the selected row.
          const hidden = count - win.size;
          assert.ok(
            hidden <= 0 || cap <= 2,
            `indicators omitted only when idle or cramped: ${JSON.stringify(win)} count=${count} cap=${cap}`,
          );
          continue;
        }
        assert.equal(win.topMore, win.start);
        assert.equal(win.bottomMore, count - win.start - win.size);
        assert.ok(
          win.size + (win.topMore > 0 ? 1 : 0) + (win.bottomMore > 0 ? 1 : 0) <=
            Math.max(cap, 1),
        );
      }
    }
  }
});

test("dashboard handles long, CJK, and control-containing names", () => {
  const snaps = [
    makeTestSnap({ id: "sa-long", taskName: `Fix ${"x".repeat(300)} dispatch` }),
    makeTestSnap({ id: "sa-cjk", taskName: "子代理人測試任務工作排程".repeat(10) }),
    makeTestSnap({ id: "sa-ctl", taskName: "a\tb\x00c\nd <done>?" }),
  ];
  for (const width of [1, 2, 8, 12, 40, 80]) {
    for (const rows of [3, 8, 24]) {
      const dashboard = openDashboard(makeFakeView(snaps), rows);
      try {
        const lines = dashboard.render(width);
        assertRenderContract(lines, width, rows);
        for (const line of lines) {
          // truncateToWidth may emit its own ANSI resets; content control
          // chars must still be sanitized away.
          const withoutAnsi = line.replace(/\u001b\[[0-9;]*m/g, "");
          assert.ok(
            !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(withoutAnsi),
            `control chars must be sanitized: ${JSON.stringify(line)}`,
          );
        }
      } finally {
        dashboard.dispose();
      }
    }
  }
});

test("takeover sanitizes control characters in agent metadata", () => {
  const snap = makeTakeoverSnap("sa\ncontrol");
  (snap as { role: string }).role = "worker\u0000\nrole";
  const view = makeFakeView([snap]);
  const takeover = openTakeover(view, snap.id, 24);
  try {
    for (const width of [8, 12, 80]) {
      const lines = takeover.render(width);
      assertRenderContract(lines, width, 24);
      for (const line of lines) {
        const withoutAnsi = line.replace(/\u001b\[[0-9;]*m/g, "");
        assert.ok(
          !/[\u0000-\u001f\u007f]/.test(withoutAnsi),
          `control chars must be sanitized: ${JSON.stringify(line)}`,
        );
      }
    }
  } finally {
    takeover.dispose();
  }
});

function makeTakeoverSnap(id = "sa-1"): SubagentSnapshot {
  return makeTestSnap({
    id,
    taskName: "Inspect the widgets",
    status: "running",
    transcript: [
      { kind: "user", text: "Inspect the widgets." },
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
        outputPreview: "export const answer = 42;",
      },
    ],
    turns: 2,
  });
}

function openTakeover(
  view: FakeSubagentView,
  id: string,
  rows: number,
  onRender?: () => void,
  options?: { hasPendingQuestion?: (id: string) => boolean },
): TakeoverView {
  return new TakeoverView(
    makeFakeTui(rows, onRender),
    makePlainTheme(),
    makeTestKeybindings(),
    id,
    view,
    () => {},
    options,
  );
}

test("takeover render stays within width/height budgets", () => {
  const snap = makeTakeoverSnap();
  const present = makeFakeView([snap]);
  const missing = makeFakeView([]);
  for (const rows of RENDER_HEIGHTS) {
    for (const width of RENDER_WIDTHS) {
      for (const [view, id] of [
        [present, snap.id],
        [missing, "sa-missing"],
      ] as const) {
        const takeover = openTakeover(view, id, rows);
        try {
          assertRenderContract(takeover.render(width), width, rows);
        } finally {
          takeover.dispose();
        }
      }
    }
  }
});

test("takeover actions and hints follow injected keybindings", () => {
  const snap = makeTakeoverSnap();
  const view = makeFakeView([snap]);
  const keybindings = makeTestKeybindings({
    "app.interrupt": ["f1"],
    "app.clear": ["f2"],
  });
  let done = false;
  const takeover = new TakeoverView(
    makeFakeTui(24),
    makePlainTheme(),
    keybindings,
    snap.id,
    view,
    () => {
      done = true;
    },
  );
  try {
    const bottom = takeover.render(80).at(-1) ?? "";
    assert.ok(bottom.includes("f1"), bottom);
    assert.ok(bottom.includes("f2"), bottom);
    assert.ok(!bottom.includes("escape"), bottom);
    takeover.handleInput("f2");
    assert.deepEqual(view.aborted, [snap.id]);
    takeover.handleInput("f1");
    assert.equal(done, true);
  } finally {
    takeover.dispose();
  }
});

test("takeover shows blocking questions and keeps input reachable", () => {
  const snap = makeTakeoverSnap();
  const view = makeFakeView([snap]);
  const asked = openTakeover(view, snap.id, 24, undefined, {
    hasPendingQuestion: () => true,
  });
  try {
    const lines = asked.render(80);
    assertRenderContract(lines, 80, 24);
    assert.ok(lines[0].includes("needs answer"), lines[0]);
    assert.ok(
      lines.some((line) => line.includes("close")),
      "cancel hint should stay visible",
    );
  } finally {
    asked.dispose();
  }
  const quiet = openTakeover(
    makeFakeView([
      makeTakeoverSnap("sa-9"),
    ]),
    "sa-9",
    24,
  );
  try {
    assert.ok(!quiet.render(80).join("\n").includes("needs answer"));
  } finally {
    quiet.dispose();
  }
});

test("takeover theme invalidation rebuilds cached transcript lines", () => {
  let tag = "A";
  const theme = {
    fg: (color: string, text: string) =>
      color === "toolTitle" ? `[${tag}:${text}]` : text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as Theme;
  const snap = makeTakeoverSnap();
  const takeover = new TakeoverView(
    makeFakeTui(24),
    theme,
    makeTestKeybindings(),
    snap.id,
    makeFakeView([snap]),
    () => {},
  );
  try {
    const first = takeover.render(80).join("\n");
    assert.ok(first.includes("[A:read]"), first);
    tag = "B";
    const cached = takeover.render(80).join("\n");
    assert.ok(cached.includes("[A:read]"), "transcript cache should hold");
    takeover.invalidate();
    const rebuilt = takeover.render(80).join("\n");
    assert.ok(rebuilt.includes("[B:read]"), rebuilt);
  } finally {
    takeover.dispose();
  }
});

test("takeover coalesces rapid snapshot updates into one repaint", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const snap = makeTakeoverSnap();
    const view = makeFakeView([snap]);
    let renders = 0;
    const takeover = openTakeover(view, snap.id, 24, () => {
      renders += 1;
    });
    try {
      view.fire(snap.id);
      view.fire(snap.id);
      view.fire(snap.id);
      assert.equal(renders, 0);
      mock.timers.tick(50);
      assert.equal(renders, 1);
    } finally {
      takeover.dispose();
    }
  } finally {
    mock.timers.reset();
  }
});

test("takeover only ticks while the agent can visibly change", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const runningSnap = makeTakeoverSnap("sa-1");
    const settledSnap = makeTakeoverSnap("sa-2");
    (settledSnap as { status: SubagentSnapshot["status"] }).status = "done";
    assert.equal(takeoverNeedsTicker(settledSnap), false);
    assert.equal(takeoverNeedsTicker(undefined), false);
    assert.equal(takeoverNeedsTicker(runningSnap), true);

    let renders = 0;
    const running = openTakeover(
      makeFakeView([runningSnap]),
      runningSnap.id,
      24,
      () => {
        renders += 1;
      },
    );
    let settledRenders = 0;
    const settled = openTakeover(
      makeFakeView([settledSnap]),
      settledSnap.id,
      24,
      () => {
        settledRenders += 1;
      },
    );
    mock.timers.tick(2000);
    assert.ok(renders >= 2, `expected ticks, saw ${renders}`);
    assert.equal(settledRenders, 0);
    running.dispose();
    settled.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("takeover and dashboard disposal stops timers safely", () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    let renders = 0;
    const view = makeFakeView([makeTakeoverSnap()]);
    const takeover = openTakeover(view, "sa-1", 24, () => {
      renders += 1;
    });
    const dashboard = openDashboard(makeFakeView([makeTestSnap()]), 24);
    takeover.dispose();
    dashboard.dispose();
    takeover.dispose();
    dashboard.dispose();
    mock.timers.tick(5000);
    assert.equal(renders, 0);
  } finally {
    mock.timers.reset();
  }
});
