/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into visually distinct lines.
 *
 * Content types are rendered with clear visual hierarchy:
 *
 *   User messages      →  > text (accent prefix)
 *   Thinking            →  ~ italic muted  (dim prefix)
 *   Assistant text      →  plain wrapped (default text)
 *   Tool calls+results  →  compact activity rows with a one-line preview
 *
 * ── Tool activity ───────────────────────────────────────────
 *
 *   ✓ read  /path/to/file
 *     ↳ file content preview
 *   ◌ bash  npm test
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

// ── Tool activity primitives ────────────────────────────────────────────────

function summarizeToolDetail(detail: string | undefined): string {
  const cleanDetail = detail ? sanitizeText(detail).trim() : "";
  if (!cleanDetail.startsWith("{")) return cleanDetail;

  try {
    const input = JSON.parse(cleanDetail) as Record<string, unknown>;
    for (const key of ["path", "command", "query", "url"]) {
      if (typeof input[key] === "string") return input[key];
    }
  } catch {
    // Keep an unparseable argument preview intact rather than hiding it.
  }

  return cleanDetail;
}

function toolActivity(
  theme: Theme,
  status: "done" | "error" | "running",
  name: string,
  detail: string | undefined,
  width: number,
): string {
  const [glyph, color] =
    status === "done"
      ? ["✓", "success"]
      : status === "error"
        ? ["✗", "error"]
        : ["◌", "warning"];
  const cleanDetail = summarizeToolDetail(detail);
  const prefix =
    `${theme.fg(color as any, glyph)} ${theme.fg("toolTitle", name)}`;
  const available = Math.max(0, width - visibleWidth(prefix) - 2);
  const suffix = cleanDetail
    ? theme.fg("muted", `  ${truncateToWidth(cleanDetail, available)}`)
    : "";
  return truncateToWidth(prefix + suffix, width);
}

function toolPreview(
  theme: Theme,
  output: string | undefined,
  width: number,
): string | undefined {
  const firstLine = output
    ? sanitizeText(output).split("\n").find((line) => line.trim())
    : undefined;
  if (!firstLine) return undefined;
  return truncateToWidth(
    theme.fg("dim", "  ↳ ") + theme.fg("toolOutput", firstLine.trim()),
    width,
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
 * `width`. Tool calls and results share compact rows to keep the transcript
 * scan-friendly during busy subagent runs.
 */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const out: string[] = [];
  // Keep enough call metadata to render its matching result as one activity
  // row. Multiple tools can remain open while parallel calls are in flight.
  const openTools = new Map<string, { name: string; argsPreview?: string }>();

  const closeOpenTools = () => {
    for (const [toolId, tool] of openTools) {
      out.push(
        toolActivity(theme, "error", tool.name, tool.argsPreview, width),
      );
      openTools.delete(toolId);
    }
  };

  for (const item of snap.transcript) {
    if (item.kind === "user") {
      closeOpenTools();
      addSeparator(theme, width, out);
      renderUserText(theme, item.text, width, out);
    } else if (item.kind === "assistant") {
      closeOpenTools();
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
          openTools.set(part.toolId, {
            name: part.name,
            argsPreview:
              part.argsPreview && part.argsPreview !== "{}"
                ? part.argsPreview
                : undefined,
          });
        }
      }
    } else {
      const tool = openTools.get(item.toolId);
      if (!tool) addSeparator(theme, width, out);
      out.push(
        toolActivity(
          theme,
          item.isError ? "error" : "done",
          tool?.name ?? item.name,
          tool?.argsPreview,
          width,
        ),
      );
      const preview = toolPreview(theme, item.outputPreview, width);
      if (preview) out.push(preview);
      openTools.delete(item.toolId);
    }
  }

  // Close any calls that ended without a matching result.
  closeOpenTools();

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
    out.push(
      toolActivity(
        theme,
        tool.done ? (tool.isError ? "error" : "done") : "running",
        tool.name,
        detail,
        width,
      ),
    );
    if (tool.done) {
      const preview = toolPreview(theme, tool.outputPreview, width);
      if (preview) out.push(preview);
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
