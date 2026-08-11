/**
 * Takeover UI for subagents (rendered from the synchronous SubagentReadModel):
 * - SubagentDashboard: compact centered dialog listing all subagents.
 * - TakeoverView: interactive view of one subagent with an input line
 *   to steer/continue it.
 *
 * Rendering contract: render() returns exactly as many lines as the content
 * needs (the TUI sizes the centered overlay from that), every line must stay
 * within `width`, and the total must never exceed the terminal height.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatElapsed,
  formatModelWithThinking,
  type SubagentSnapshot,
} from "../domain.ts";
import { formatContextUtilization } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { buildTranscriptLines, sanitizeText } from "./transcript.ts";

/** Dialog width; clamped by the TUI to the terminal width. */
const OVERLAY_WIDTH = 120;
const TRANSCRIPT_SCROLL_STEP = 6;

function oneLine(text: string) {
  return sanitizeText(text.replace(/\s+/g, " ")).trim();
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

/**
 * A dialog bar line: ╭─ <left label> ─<mid> <right label> ─╮ (or ╰…╯).
 * Labels already carry their own surrounding spaces. The result is exactly
 * `innerWidth + 2` columns wide (never wider); on narrow terminals the right
 * label is dropped before the left one is truncated.
 */
function bar(
  theme: Theme,
  left: "╭" | "╰",
  right: "╮" | "╯",
  leftLabel: string,
  rightLabel: string,
  innerWidth: number,
): string {
  const dash = theme.fg("borderMuted", "─");
  // Labels carry their own surrounding spaces; mid restores the exact width
  // (corner + dash + leftLabel + mid + rightLabel + dash + corner).
  const mid =
    innerWidth - visibleWidth(leftLabel) - visibleWidth(rightLabel) - 2;
  if (mid >= 1) {
    return (
      theme.fg("border", left) +
      dash +
      leftLabel +
      dash.repeat(mid) +
      rightLabel +
      dash +
      theme.fg("border", right)
    );
  }
  // Not enough room for both labels: keep the left, drop the right.
  const label = truncateToWidth(leftLabel, Math.max(2, innerWidth - 3));
  const fill = Math.max(1, innerWidth - visibleWidth(label) - 1);
  return (
    theme.fg("border", left) +
    dash +
    label +
    dash.repeat(fill) +
    theme.fg("border", right)
  );
}

// --- Entry point ---------------------------------------------------------------

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: OVERLAY_WIDTH,
          maxHeight: "100%",
        },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
        new TakeoverView(tui, theme, keybindings, picked, view, done),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: OVERLAY_WIDTH,
          maxHeight: "100%",
        },
      },
    );
    // After leaving the takeover view, fall back to the dashboard.
  }
}

// --- Dashboard (centered dialog) ----------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

export class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;

  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    // Elapsed times and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    return this.view.list();
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    return true;
  }

  private close(result: string | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + subs.length) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = subs[this.selection.index];
      if (snap && snap.status === "running") this.view.requestAbort(snap.id);
      return;
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    const rows = this.tui.terminal.rows ?? 30;
    const innerWidth = Math.max(10, width - 2);
    // Content-sized dialog: shell (title + summary + bar) plus one row per
    // agent, but never taller than the terminal minus a small margin.
    const bodyHeight = Math.min(
      Math.max(1, subs.length),
      Math.max(3, rows - 7),
    );

    const lines: string[] = [];

    // Title bar: ╭─ Subagents ──────────── 5 agents ─╮
    const countLabel = `${subs.length} agent${subs.length === 1 ? "" : "s"}`;
    lines.push(
      bar(
        theme,
        "╭",
        "╮",
        ` ${theme.fg("accent", theme.bold("Subagents"))} `,
        ` ${theme.fg("muted", countLabel)} `,
        innerWidth,
      ),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(subs, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider);
    }

    // Status summary: ■ 2 running · ■ 1 done · ■ 1 failed
    const running = subs.filter((s) => s.status === "running").length;
    const done = subs.filter((s) => s.status === "done").length;
    const failed = subs.length - running - done;
    const dot = theme.fg("dim", " · ");
    const counts: string[] = [];
    if (running > 0) counts.push(theme.fg("warning", `■ ${running} running`));
    if (done > 0) counts.push(theme.fg("success", `■ ${done} done`));
    if (failed > 0) counts.push(theme.fg("error", `■ ${failed} failed`));
    lines.push(
      divider +
        this.pad(
          ` ${counts.length > 0 ? counts.join(dot) : theme.fg("dim", "no subagents")} `,
          innerWidth,
        ) +
        divider,
    );

    // Bottom bar: ╰─ ───────────── esc close · x stop ─╯
    const hints =
      `${configuredKeys(this.keybindings, "tui.select.cancel")} close · x stop `;
    lines.push(
      bar(theme, "╰", "╯", theme.fg("dim", ` ${hints}`), "", innerWidth),
    );

    return lines;
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (subs.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        subs.length - height,
      );
    }
    const visible = subs.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      // Left: marker, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", oneLine(snap.title))
        : theme.fg("text", oneLine(snap.title));
      const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", `· ${snap.id}`)}`;

      // Right: elapsed · status
      const right = `${theme.fg("muted", formatElapsed(snap))} ${statusWord(snap, theme)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax);
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   … ${start} more`), width);
    }
    if (start + height < subs.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   … ${subs.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view --------------------------------------------------------------

/**
 * Keep the same transcript lines visible when new output arrives above the
 * tail.
 */
export function preserveScrolledOffset(
  scrollOffset: number,
  previousLineCount: number | undefined,
  nextLineCount: number,
): number {
  if (scrollOffset === 0 || previousLineCount === undefined) {
    return scrollOffset;
  }
  return Math.max(0, scrollOffset + nextLineCount - previousLineCount);
}

export class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;

  private input = new Input();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private previousTranscriptLineCount?: number;
  private previousTranscriptWidth?: number;
  private hasPendingSnapshotUpdate = false;
  /** Fingerprint-keyed transcript lines: streaming re-renders stay cheap. */
  private transcriptKey = "";
  private transcriptLines: string[] = [];
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => {
      this.hasPendingSnapshotUpdate = true;
      this.scheduleRender();
    });
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  private viewportHeight(rows: number): number {
    // Chrome: title bar, details, input row, bottom bar = 4 rows. Leave the
    // terminal footer plus one row of breathing room below the dialog.
    return Math.max(2, rows - 8);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestAbort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight(this.tui.terminal.rows ?? 30);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(this.tui.terminal.rows ?? 30),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  /** Cheap identity of everything that changes the rendered transcript. */
  private currentTranscriptKey(snap: SubagentSnapshot, width: number): string {
    const items = snap.transcript;
    const last = items[items.length - 1];
    return [
      width,
      snap.status,
      snap.turns,
      items.length,
      last?.kind ?? "",
      snap.liveTools
        .map((t) => `${t.toolId}:${t.outputPreview?.length ?? 0}:${t.done ? 1 : 0}`)
        .join(","),
      snap.queued.length,
      snap.liveAssistant?.text.length ?? 0,
      snap.liveAssistant?.thinking.length ?? 0,
      snap.errorText?.length ?? 0,
      snap.finalText.length,
    ].join("|");
  }

  private transcript(snap: SubagentSnapshot, width: number): string[] {
    const key = this.currentTranscriptKey(snap, width);
    if (key !== this.transcriptKey) {
      this.transcriptKey = key;
      this.transcriptLines = buildTranscriptLines(snap, width, this.theme);
    }
    return this.transcriptLines;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const innerWidth = Math.max(1, width - 2);
    const divider = theme.fg("border", "│");
    const rows = this.tui.terminal.rows ?? 30;
    const lines: string[] = [];
    const snap = this.snap();
    const framed = (content: string) => {
      const clipped = truncateToWidth(content, Math.max(0, innerWidth - 1));
      return (
        divider +
        " " +
        clipped +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped) - 1)) +
        divider
      );
    };
    const detailLabel = (text: string) => theme.fg("muted", text);

    if (!snap) {
      lines.push(
        bar(
          theme,
          "╭",
          "╮",
          ` ${theme.fg("accent", theme.bold("Subagent"))} `,
          "",
          innerWidth,
        ),
      );
      lines.push(framed(theme.fg("dim", `${this.id} is no longer tracked`)));
      lines.push(bar(theme, "╰", "╯", "", "", innerWidth));
      return lines;
    }

    // Title bar: ╭─ ■ <title> · <id> ───── running ─╮
    const titleLabel =
      ` ${statusGlyph(snap, theme)} ` +
      theme.fg("text", theme.bold(oneLine(snap.title))) +
      theme.fg("dim", ` · ${snap.id} `);
    lines.push(
      bar(theme, "╭", "╮", titleLabel, ` ${statusWord(snap, theme)} `, innerWidth),
    );

    // Details: model · context · elapsed · turns (no labels needed)
    const utilization = formatContextUtilization(snap.usage);
    const details: string[] = [
      detailLabel(oneLine(formatModelWithThinking(snap.meta, "unknown"))),
    ];
    if (utilization) details.push(detailLabel(utilization));
    details.push(detailLabel(formatElapsed(snap)));
    details.push(detailLabel(`${snap.turns} turns`));
    lines.push(framed(details.join(theme.fg("dim", " · "))));

    // Fixed-height transcript viewport. Error and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    const contentWidth = Math.max(1, innerWidth - 2);
    const transcriptLines = this.transcript(snap, contentWidth);
    // The offset is tail-relative. Compensate for appended streamed lines so a
    // reader who scrolled up stays on the exact output they were inspecting.
    if (
      this.hasPendingSnapshotUpdate &&
      this.previousTranscriptWidth === contentWidth
    ) {
      this.scrollOffset = preserveScrolledOffset(
        this.scrollOffset,
        this.previousTranscriptLineCount,
        transcriptLines.length,
      );
    }
    this.previousTranscriptLineCount = transcriptLines.length;
    this.previousTranscriptWidth = contentWidth;
    this.hasPendingSnapshotUpdate = false;

    const viewport = this.viewportHeight(rows);
    const noteRows: string[] = [];
    if (snap.errorText) {
      noteRows.push(
        truncateToWidth(
          theme.fg("error", "✗ ") +
            theme.fg("error", oneLine(snap.errorText)),
          contentWidth,
        ),
      );
    }

    const body: string[] = [...noteRows];
    const paused = this.scrollOffset > 0;
    const capacity = Math.max(1, viewport - body.length - (paused ? 1 : 0));
    const maxOffset = Math.max(0, transcriptLines.length - capacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const end = transcriptLines.length - this.scrollOffset;
    const visible = transcriptLines.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) {
      body.push(
        theme.fg("warning", "◌ ") + theme.fg("dim", "waiting for activity"),
      );
    } else {
      body.push(...visible);
    }

    if (paused) {
      body.push(
        truncateToWidth(
          theme.fg("warning", "↑ paused ") +
            theme.fg(
              "dim",
              `· ${this.scrollOffset} newer · down/pageDown to follow`,
            ),
          contentWidth,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport).map(framed));

    // Input row (Input draws its own "> " prompt)
    lines.push(framed(this.input.render(contentWidth)[0] ?? ""));

    // Bottom bar: ╰─ ───────────────── esc close · ctrl+c stop ─╯
    const hints =
      `${configuredKeys(this.keybindings, "app.interrupt")} close · ` +
      `${configuredKeys(this.keybindings, "app.clear")} stop`;
    lines.push(
      bar(theme, "╰", "╯", theme.fg("dim", ` ${hints} `), "", innerWidth),
    );

    return lines;
  }

  invalidate(): void {
    // Drop cached transcript lines so the next render rebuilds with the
    // current theme (the key mismatch forces the rebuild).
    this.transcriptKey = "";
    this.input.invalidate();
  }
}