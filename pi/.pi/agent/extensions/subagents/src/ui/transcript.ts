/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into visually distinct lines.
 *
 * Content types are rendered with clear visual hierarchy:
 *
 *   User messages      →  > text (accent prefix)
 *   Thinking            →  ~ italic muted  (dim prefix)
 *   Assistant text      →  plain wrapped (default text)
 *   Tool calls+results  →  framed cards with status
 *
 * ── Tool cards ──────────────────────────────────────────────
 *
 *   ╭─ read  /path/to/file ─────────────────╮
 *   │ file content here                      │
 *   ╰● done ────────────────────────────────╯
 *
 *   ╭─ write ───────────────────────────────╮
 *   ╰● error ───────────────────────────────╯
 *
 *   ╭─ bash ────────────────────────────────╮
 *   │ total 15G ...                          │
 *   ╰● running ─────────────────────────────╯
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SubagentSnapshot, TranscriptItem } from "../domain.ts";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// ── Tool card primitives ────────────────────────────────────────────────────
// Each card is exactly `inner` columns wide.

function cardTop(
  t: Theme,
  name: string,
  detail: string | undefined,
  inner: number,
): string {
  const tag = ` ${name}${detail ? ` ${truncateToWidth(detail, Math.max(0, inner - name.length - 6))}` : ""} `;
  const tagW = visibleWidth(tag);
  const fill = Math.max(0, inner - tagW - 2);
  return (
    t.fg("border", "╭─") +
    t.fg("toolTitle", tag) +
    t.fg("border", "─".repeat(fill) + "╮")
  );
}

function cardMid(
  t: Theme,
  text: string,
  inner: number,
  fg: string = "toolOutput",
): string {
  const clipped = truncateToWidth(text, inner - 2);
  const pad = Math.max(0, inner - visibleWidth(clipped) - 2);
  return (
    t.fg("border", "│") +
    " " +
    t.fg(fg as any, clipped) +
    " ".repeat(pad) +
    t.fg("border", "│")
  );
}

function cardBot(
  t: Theme,
  status: "done" | "error" | "running",
  inner: number,
): string {
  const color =
    status === "done" ? "success" : status === "error" ? "error" : "warning";
  const bullet = "\u25cf"; // ●
  const label = ` ${bullet} ${status} `;
  const labelW = visibleWidth(label);
  const fill = Math.max(0, inner - labelW - 2);
  return (
    t.fg("border", "\u2570\u2500") + // ╰─
    t.fg(color as any, label) +
    t.fg("border", "\u2500".repeat(fill) + "\u256f") // ──╯
  );
}

function cardEmpty(t: Theme, inner: number): string {
  return (
    t.fg("border", "\u2502") +
    " " +
    t.fg("dim", truncateToWidth("(no output)", inner - 2)) +
    " ".repeat(Math.max(0, inner - visibleWidth("(no output)") - 2)) +
    t.fg("border", "\u2502")
  );
}

// ── Content renderers ───────────────────────────────────────────────────────

function renderUserText(
  t: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const wrapped = wrapTextWithAnsi(clean, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    const prefix = i === 0 ? t.fg("accent", "> ") : "  ";
    out.push(
      truncateToWidth(prefix + t.fg("userMessageText", wrapped[i]), width),
    );
  }
}

function renderThinking(
  t: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const reasoning = sanitizeText(text).trim();
  if (!reasoning) return;
  const prefix = t.fg("dim", "~ ");
  const wrapped = wrapTextWithAnsi(reasoning, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    out.push(
      truncateToWidth(
        (i === 0 ? prefix : "  ") +
          t.fg("muted", t.italic(wrapped[i])),
        width,
      ),
    );
  }
}

function renderAssistantText(t: Theme, text: string, width: number, out: string[]) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  // Assistant body text is the default conversation content — keep it clean
  // and readable without extra decoration.
  const wrapped = wrapTextWithAnsi(clean, width);
  out.push(...wrapped);
}

function addSeparator(t: Theme, width: number, out: string[]) {
  if (out.length > 0 && out[out.length - 1] !== "") {
    out.push("");
  }
}

// ── Transcript painter ──────────────────────────────────────────────────────

/**
 * Render a subagent's conversation as visually distinct lines, wrapped to
 * `width`. Tool calls and their results are grouped into framed cards.
 */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = [];
  // Track tool call cards opened by an assistant part and not yet closed by
  // a toolResult. Multiple cards may be open at once (parallel tool calls).
  const openCards = new Map<
    string,
    { name: string; argsPreview?: string }
  >();
  // Tracks the number of consecutive tool-result lines so we can suppress the
  // spacer between them (they belong to the same logical card).
  let lastWasToolResult = false;

  const closeOpenCards = (forceEmpty = false) => {
    if (openCards.size === 0) return;
    for (const [toolId] of openCards) {
      if (forceEmpty) {
        out.push(cardEmpty(theme, width));
      }
      out.push(cardBot(theme, "error", width));
      openCards.delete(toolId);
    }
    lastWasToolResult = false;
  };

  for (const item of snap.transcript) {
    if (item.kind === "user") {
      closeOpenCards();
      addSeparator(theme, width, out);
      renderUserText(theme, item.text, width, out);
      lastWasToolResult = false;
    } else if (item.kind === "assistant") {
      closeOpenCards();
      addSeparator(theme, width, out);

      for (const part of item.parts) {
        if (part.type === "text") {
          renderAssistantText(theme, part.text, width, out);
        } else if (part.type === "thinking") {
          renderThinking(
            theme,
            part.redacted ? "[redacted reasoning]" : part.text,
            width,
            out,
          );
        } else if (part.type === "toolCall") {
          // Start a card. The matching toolResult will fill in the body and
          // close it. If no result arrives (e.g., parallel error), the card
          // stays open and gets closed with an error footer before the next
          // non-result item.
          openCards.set(part.toolId, {
            name: part.name,
            argsPreview: part.argsPreview,
          });
          const preview =
            part.argsPreview && part.argsPreview !== "{}"
              ? sanitizeText(part.argsPreview).slice(0, 120)
              : undefined;
          out.push(cardTop(theme, part.name, preview, width));
        }
      }
      lastWasToolResult = false;
    } else {
      // toolResult — fill in the matching card body and close it.
      const info = openCards.get(item.toolId);
      if (info) {

        const output = item.outputPreview
          ? sanitizeText(item.outputPreview)
          : "";
        const lines = output.split("\n").filter(Boolean);
        const maxLines = 12;
        const shown = lines.slice(0, maxLines);

        for (const line of shown) {
          out.push(cardMid(theme, line, width));
        }
        if (lines.length > maxLines) {
          out.push(
            cardMid(
              theme,
              `... ${lines.length - maxLines} more lines`,
              width,
            ),
          );
        }
        if (!output) {
          out.push(cardEmpty(theme, width));
        }
        out.push(
          cardBot(theme, item.isError ? "error" : "done", width),
        );
        openCards.delete(item.toolId);
      } else {
        // Orphan result (no matching call in transcript — edge case).
        addSeparator(theme, width, out);
        out.push(cardTop(theme, item.name, undefined, width));
        const preview = item.outputPreview
          ? sanitizeText(item.outputPreview)
          : "";
        if (preview) {
          const first = preview.split("\n")[0] || "";
          out.push(cardMid(theme, first, width));
        } else {
          out.push(cardEmpty(theme, width));
        }
        out.push(cardBot(theme, item.isError ? "error" : "done", width));
      }
      lastWasToolResult = true;
    }
  }

  // Close any cards left open (run ended mid-tool with no result).
  closeOpenCards(true);

  // Trim trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  // ── Live streaming assistant buffers ────────────────────────────────────
  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    const before = out.length;
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    if (thinking.trim()) renderThinking(theme, thinking, width, out);
    if (text.trim()) renderAssistantText(theme, text, width, out);
    if (out.length === before && before > 0 && out[out.length - 1] === "") {
      out.pop();
    }
  }

  // ── Live tool executions ────────────────────────────────────────────────
  for (const tool of snap.liveTools) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    const detail =
      tool.outputPreview && sanitizeText(tool.outputPreview).split("\n")[0];
    out.push(cardTop(theme, tool.name, detail, width));
    if (tool.done) {
      // ToolEnd already landed but the transcript hasn't been flushed yet.
      const preview = tool.outputPreview
        ? sanitizeText(tool.outputPreview)
        : "";
      const firstLine = preview.split("\n").find((l) => l.trim());
      if (firstLine) {
        out.push(cardMid(theme, firstLine, width));
      } else {
        out.push(cardEmpty(theme, width));
      }
      out.push(cardBot(theme, tool.isError ? "error" : "done", width));
    } else {
      // Still running — show a live card.
      out.push(cardBot(theme, "running", width));
    }
  }

  // ── Queued steering / follow-up messages ────────────────────────────────
  for (const message of snap.queued) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    const clean = sanitizeText(message.text).trim();
    if (!clean) continue;
    const prefix = theme.fg("warning", `[queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(clean, Math.max(10, width - 2));
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
        ),
      );
    }
  }

  return out;
}
