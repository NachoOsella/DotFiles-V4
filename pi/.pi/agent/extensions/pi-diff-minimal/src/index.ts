/**
 * pi-diff-minimal — Shiki-powered terminal diff renderer for pi.
 *
 * Only hooks into write/edit tools to show enhanced diffs:
 *   - Syntax-highlighted via Shiki (190+ languages)
 *   - Split view (side-by-side) or unified view (stacked)
 *   - Word-level emphasis on changed characters
 *   - Colors derived from user's pi theme
 *
 * No review commands, no TUI overlay, no CLI, no prompts — just diffs.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

import {
	applyDiffPalette,
	lang as detectDiffLanguage,
	renderCodeFrame,
	renderSplit,
	resolveDiffColors,
	themeCacheKey,
} from "./renderer.js";
import { parseDiff } from "./core/diff.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_TERM_WIDTH = 210;
const DEFAULT_TERM_WIDTH = 200;
const MIN_TERM_WIDTH = 40;

const MAX_PREVIEW_LINES = 60; // edit tool preview
const MAX_RENDER_LINES = 150; // write tool result
const MAX_WRITE_NEW_PREVIEW_LINES = 80;

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Width to render diffs at. Pi's tool content area is roughly raw - 8. */
function termW(): number {
	const raw =
		process.stdout.columns ||
		(process.stderr as any).columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		DEFAULT_TERM_WIDTH;

	// raw - 8 accounts for terminal chrome (scrollbar, border) + Pi's box padding (1 each side)
	return Math.max(MIN_TERM_WIDTH, Math.min(raw - 8, MAX_TERM_WIDTH));
}

function shortPath(cwd: string, home: string, p: string): string {
	if (!p) return "";
	const r = relative(cwd, p);
	if (!r.startsWith("..") && !r.startsWith("/")) return r;
	return p.replace(home, "~");
}

function summarize(a: number, d: number): string {
	const p: string[] = [];
	if (a > 0) p.push(`+${a}`);
	if (d > 0) p.push(`-${d}`);
	return p.length ? p.join(" ") : "no changes";
}

// ---------------------------------------------------------------------------
// Edit tool helpers
// ---------------------------------------------------------------------------

function getEditOperations(input: any): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((edit: any) => ({
				oldText:
					typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText:
					typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit: { oldText: string; newText: string }) => edit.oldText && edit.oldText !== edit.newText);
	}

	const oldText =
		typeof input?.oldText === "string" ? input.oldText : typeof input?.old_text === "string" ? input.old_text : "";
	const newText =
		typeof input?.newText === "string" ? input.newText : typeof input?.new_text === "string" ? input.new_text : "";
	return oldText && oldText !== newText ? [{ oldText, newText }] : [];
}

function summarizeEditOperations(operations: Array<{ oldText: string; newText: string }>) {
	const diffs = operations.map((edit) => parseDiff(edit.oldText, edit.newText));
	const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0);
	const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0);
	return {
		diffs,
		totalAdded,
		totalRemoved,
		summary: summarize(totalAdded, totalRemoved),
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function diffRendererExtension(pi: any): Promise<void> {
	// Apply diff theme palette from env/settings before rendering
	applyDiffPalette();

	let createWriteTool: any, createEditTool: any, TextComponent: any;
	try {
		const sdk = await import("@mariozechner/pi-coding-agent");
		const tui = await import("@mariozechner/pi-tui");
		createWriteTool = sdk.createWriteTool;
		createEditTool = sdk.createEditTool;
		TextComponent = tui.Text;
	} catch (error) {
		console.error(
			`[pi-diff-minimal] failed to load Pi SDK dependencies: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	if (!createWriteTool || !createEditTool || !TextComponent) return;

	const cwd = process.cwd();
	const home = process.env.HOME ?? "";
	const sp = (p: string) => shortPath(cwd, home, p);

	// =======================================================================
	// write
	// =======================================================================

	const origWrite = createWriteTool(cwd);

	pi.registerTool({
		...origWrite,
		name: "write",

		async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
			const fp = params.path ?? params.file_path ?? "";
			let old: string | null = null;
			try {
				if (fp && existsSync(fp)) old = readFileSync(fp, "utf-8");
			} catch {
				old = null;
			}

			const result = await origWrite.execute(tid, params, sig, upd, ctx);
			const content = params.content ?? "";

			// Store diff info in details for TUI rendering
			if (old !== null && old !== content) {
				const diff = parseDiff(old, content);
				const lg = detectDiffLanguage(fp);
				(result as any).details = { _type: "diff", summary: summarize(diff.added, diff.removed), diff, language: lg };
			} else if (old === null) {
				const lineCount = content ? content.split("\n").length : 0;
				(result as any).details = { _type: "new", lines: lineCount, content: content ?? "", filePath: fp };
			} else if (old === content) {
				(result as any).details = { _type: "noChange" };
			}
			return result;
		},

		renderCall(args: any, theme: any, ctx: any) {
			const fp = args?.path ?? args?.file_path ?? "";
			const isNew = !fp || !existsSync(fp);
			const label = isNew ? "create" : "write";
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const hdr = `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", sp(fp))}`;

			// Streaming
			if (args?.content && !ctx.argsComplete) {
				const n = String(args.content).split("\n").length;
				text.setText(`${hdr}  ${theme.fg("muted", `(${n} lines…)`)}`);
				return text;
			}

			// New file preview: compact rendered code, without diff markers or split columns.
			if (args?.content && ctx.argsComplete && isNew) {
				const previewKey = `code-frame-preview-v1:${themeCacheKey(theme)}:${fp}:${String(args.content).length}:${termW()}`;
				if (ctx.state._previewKey !== previewKey) {
					ctx.state._previewKey = previewKey;
					ctx.state._previewText = hdr;
					const lg = detectDiffLanguage(fp);
					resolveDiffColors(theme);
					renderCodeFrame(String(args.content), lg, ctx.expanded ? Number.MAX_SAFE_INTEGER : 16, termW())
						.then((preview: string) => {
							if (ctx.state._previewKey !== previewKey) return;
							ctx.state._previewText = `${hdr}\n\n${preview}`;
							ctx.invalidate();
						})
						.catch(() => {});
				}
				text.setText(ctx.state._previewText ?? hdr);
				return text;
			}

			text.setText(hdr);
			return text;
		},

		renderResult(result: any, _opt: any, theme: any, ctx: any) {
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				text.setText(`\n${theme.fg("error", e)}`);
				return text;
			}
			const d = result.details;
			if (d?._type === "diff") {
				const w = termW();
				const key = `wd:${themeCacheKey(theme)}:${w}:${d.summary}:${d.diff?.lines?.length ?? 0}:${d.language ?? ""}`;
				if (ctx.state._wdk !== key) {
					ctx.state._wdk = key;
					ctx.state._wdt = `  ${d.summary}\n${theme.fg("muted", "  rendering diff…")}`;
					const dc = resolveDiffColors(theme);
					renderSplit(d.diff, d.language, MAX_RENDER_LINES, dc, w)
						.then((rendered: string) => {
							if (ctx.state._wdk !== key) return;
							ctx.state._wdt = `  ${d.summary}\n${rendered}`;
							ctx.invalidate();
						})
						.catch(() => {
							if (ctx.state._wdk !== key) return;
							ctx.state._wdt = `  ${d.summary}`;
							ctx.invalidate();
						});
				}
				text.setText(ctx.state._wdt ?? `  ${d.summary}`);
				return text;
			}
			if (d?._type === "noChange") {
				text.setText(`  ${theme.fg("muted", "no changes")}`);
				return text;
			}
			if (d?._type === "new") {
				const { lines: lineCount, content: rawContent, filePath: fp } = d;
				const pk = `code-frame-result-v1:${themeCacheKey(theme)}:${fp}:${lineCount}:${String(rawContent ?? "").length}:${termW()}`;
				if (ctx.state._nfk !== pk) {
					ctx.state._nfk = pk;
					ctx.state._nft = `  ${theme.fg("success", `\u2713 new file (${lineCount} lines)`)}`;
					const lg = detectDiffLanguage(fp);
					if (rawContent) {
						resolveDiffColors(theme);
						renderCodeFrame(String(rawContent), lg, ctx.expanded ? Number.MAX_SAFE_INTEGER : MAX_WRITE_NEW_PREVIEW_LINES, termW())
							.then((preview: string) => {
								if (ctx.state._nfk !== pk) return;
								ctx.state._nft = `  ${theme.fg("success", `\u2713 new file (${lineCount} lines)`)}\n${preview}`;
								ctx.invalidate();
							})
							.catch(() => {});
					}
				}
				text.setText(ctx.state._nft ?? `  ${theme.fg("success", `\u2713 new file (${lineCount} lines)`)}`);
				return text;
			}
			text.setText(`  ${theme.fg("dim", String(result?.content?.[0]?.text ?? "written").slice(0, 120))}`);
			return text;
		},
	});

	// =======================================================================
	// edit
	// =======================================================================

	const origEdit = createEditTool(cwd);

	pi.registerTool({
		...origEdit,
		name: "edit",

		async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
			const fp = params.path ?? params.file_path ?? "";
			const operations = getEditOperations(params);
			const result = await origEdit.execute(tid, params, sig, upd, ctx);

			if (operations.length === 0) return result;

			const { diffs, summary } = summarizeEditOperations(operations);
			let editLine = 0;
			if (operations.length === 1) {
				try {
					if (fp && existsSync(fp)) {
						const f = readFileSync(fp, "utf-8");
						const idx = f.indexOf(operations[0].newText);
						if (idx >= 0) editLine = f.slice(0, idx).split("\n").length;
					}
				} catch {
					editLine = 0;
				}
			}

			// Store parsed diff so renderResult can show the full diff
			(result as any).details = {
				_type: "editDiff",
				summary,
				editCount: operations.length,
				editLine,
				diffs,
				language: detectDiffLanguage(fp),
				diffLineCount: diffs.reduce((sum, diff) => sum + diff.lines.length, 0),
			};
			return result;
		},

		renderCall(args: any, theme: any, ctx: any) {
			const fp = args?.path ?? args?.file_path ?? "";
			const operations = getEditOperations(args);
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const hdr = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", sp(fp))}`;

			if (!(ctx.argsComplete && operations.length > 0)) {
				text.setText(hdr);
				return text;
			}

			// Show loading immediately, then async-render the diff
			const pk = JSON.stringify({ fp, operations, theme: themeCacheKey(theme), w: termW() });
			if (ctx.state._pk !== pk) {
				ctx.state._pk = pk;
				ctx.state._pt = `${hdr}  ${theme.fg("muted", "(rendering…)")}`;
				const lg = detectDiffLanguage(fp);
				const dc = resolveDiffColors(theme);

				if (operations.length === 1) {
					const diff = parseDiff(operations[0].oldText, operations[0].newText);
					renderSplit(diff, lg, MAX_PREVIEW_LINES, dc, termW())
						.then((rendered) => {
							if (ctx.state._pk !== pk) return;
							ctx.state._pt = `${hdr}\n${summarize(diff.added, diff.removed)}\n${rendered}`;
							ctx.invalidate();
						})
						.catch(() => {
							if (ctx.state._pk !== pk) return;
							ctx.state._pt = `${hdr}  ${summarize(diff.added, diff.removed)}`;
							ctx.invalidate();
						});
				} else {
					const { diffs, summary } = summarizeEditOperations(operations);
					const maxShown = Math.min(operations.length, 3);
					const previewLines = Math.max(8, Math.floor(MAX_PREVIEW_LINES / maxShown));
					Promise.all(
						diffs.slice(0, maxShown).map((diff: any, index: number) =>
							renderSplit(diff, lg, previewLines, dc, termW())
								.then((rendered) => `Edit ${index + 1}/${operations.length}\n${rendered}`)
								.catch(() => `Edit ${index + 1}/${operations.length}  ${summarize(diff.added, diff.removed)}`),
						),
					)
						.then((sections: string[]) => {
							if (ctx.state._pk !== pk) return;
							const remainder = operations.length - maxShown;
							const suffix = remainder > 0 ? `\n${theme.fg("muted", `\u2026 ${remainder} more edit blocks`)}` : "";
							ctx.state._pt = `${hdr}\n${operations.length} edits ${summary}\n\n${sections.join("\n\n")}${suffix}`;
							ctx.invalidate();
						})
						.catch(() => {
							if (ctx.state._pk !== pk) return;
							ctx.state._pt = `${hdr}  ${operations.length} edits ${summary}`;
							ctx.invalidate();
						});
				}
			}

			text.setText(ctx.state._pt ?? hdr);
			return text;
		},

		renderResult(result: any, _opt: any, theme: any, ctx: any) {
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				text.setText(`\n${theme.fg("error", e)}`);
				return text;
			}

			if (result.details?._type === "editDiff") {
				const { summary: s, editCount, editLine, diffLineCount } = result.details;
				const loc = editCount === 1 && editLine > 0 ? ` ${theme.fg("muted", `at line ${editLine}`)}` : "";
				const count = editCount > 1 ? `${editCount} edits ` : "";
				const lineInfo = typeof diffLineCount === "number" ? ` ${theme.fg("muted", `(${diffLineCount} diff lines)`)}` : "";
				// Just a summary line: the full diff was already shown in renderCall
				text.setText(`  ${count}${s}${loc}${lineInfo}`);
				return text;
			}

			text.setText(`  ${theme.fg("dim", String(result?.content?.[0]?.text ?? "edited").slice(0, 120))}`);
			return text;
		},
	});
}
