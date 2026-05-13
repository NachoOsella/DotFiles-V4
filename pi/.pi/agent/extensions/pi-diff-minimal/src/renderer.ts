/**
 * pi-diff-minimal — Consolidated diff rendering engine.
 *
 * Architecture:
 *   1. Syntax-highlight full code blocks via Shiki -> ANSI (fg-only codes)
 *   2. Layer diff background colors underneath (composites at cell level)
 *   3. For word-level changes, inject brighter bg at changed char positions
 *   4. Result: syntax fg + diff bg + word emphasis — all three visible together
 *
 * Views:
 *   - Split (side-by-side) — edit tool, auto-falls back to unified on narrow terminals
 *   - Unified (stacked)    — write tool overwrites
 *
 * Theme integration:
 *   - Colors ALWAYS derive from the user's pi theme on first render
 *   - Explicit overrides (env vars, .pi/settings.json) apply on top of theme
 *   - Shiki syntax theme auto-detects dark/light from pi theme background
 *   - Light/dark-aware mix intensity for diff background tints
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

import { codeToANSI } from "@shikijs/cli";
import * as Diff from "diff";
import type { BundledLanguage, BundledTheme } from "shiki";

import type { ParsedDiff } from "./core/diff.js";

// ---------------------------------------------------------------------------
// Diff Theme System — presets, auto-derive, and per-color overrides
//
// Resolution chain (per color, highest priority first):
//   1. Environment variable override (e.g. DIFF_BG_ADD="#1a3320")
//   2. diffColors.X from .pi/settings.json (explicit per-color hex)
//   3. diffTheme preset value (named preset like "midnight")
//   4. Auto-derived from pi theme fg colors (ALWAYS runs unless env/settings override a specific color)
//   5. Neutral defaults (no tint — rely on theme)
// ---------------------------------------------------------------------------

/** Hex color palette for a diff theme preset. All values "#RRGGBB". */
interface DiffPreset {
	name: string;
	description: string;
	shikiTheme?: string;
	bgAdd?: string;
	bgDel?: string;
	bgAddHighlight?: string;
	bgDelHighlight?: string;
	bgGutterAdd?: string;
	bgGutterDel?: string;
	bgEmpty?: string;
	fgAdd?: string;
	fgDel?: string;
	fgDim?: string;
	fgLnum?: string;
	fgRule?: string;
	fgStripe?: string;
	fgSafeMuted?: string;
}

/** User diff config read from .pi/settings.json */
interface DiffUserConfig {
	diffTheme?: string;
	diffColors?: Record<string, string>;
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
	default: {
		name: "default",
		description: "Original pi-diff colors — tuned for dark theme bases (~#1e1e2e)",
		bgAdd: "#162620",
		bgDel: "#2d1919",
		bgAddHighlight: "#234b32",
		bgDelHighlight: "#502323",
		bgGutterAdd: "#12201a",
		bgGutterDel: "#261616",
		bgEmpty: "#121212",
		fgDim: "#505050",
		fgLnum: "#646464",
		fgRule: "#323232",
		fgStripe: "#282828",
		fgSafeMuted: "#8b949e",
	},
	midnight: {
		name: "midnight",
		description: "Subtle tints for pure black (#000000) terminal backgrounds",
		bgAdd: "#0d1a12",
		bgDel: "#1a0d0d",
		bgAddHighlight: "#1a3825",
		bgDelHighlight: "#381a1a",
		bgGutterAdd: "#091208",
		bgGutterDel: "#120908",
		bgEmpty: "#080808",
		fgDim: "#404040",
		fgLnum: "#505050",
		fgRule: "#282828",
		fgStripe: "#1e1e1e",
		fgSafeMuted: "#8b949e",
	},
	subtle: {
		name: "subtle",
		description: "Minimal backgrounds — barely-there tints for a clean look",
		bgAdd: "#081008",
		bgDel: "#100808",
		bgAddHighlight: "#122818",
		bgDelHighlight: "#281212",
		bgGutterAdd: "#060c06",
		bgGutterDel: "#0c0606",
		bgEmpty: "#060606",
		fgDim: "#383838",
		fgLnum: "#484848",
		fgRule: "#242424",
		fgStripe: "#181818",
		fgSafeMuted: "#8b949e",
	},
	neon: {
		name: "neon",
		description: "Higher contrast backgrounds for better visibility",
		bgAdd: "#1a3320",
		bgDel: "#331a16",
		bgAddHighlight: "#2d5c3a",
		bgDelHighlight: "#5c2d2d",
		bgGutterAdd: "#142818",
		bgGutterDel: "#28120e",
		bgEmpty: "#141414",
		fgDim: "#606060",
		fgLnum: "#787878",
		fgRule: "#404040",
		fgStripe: "#303030",
		fgSafeMuted: "#9da5ae",
	},
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Parse env hex color "#RRGGBB" -> ANSI 24-bit fg/bg escape, or return fallback. */
function envFg(name: string, fallback: string): string {
	const hex = process.env[name];
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function envBg(name: string, fallback: string): string {
	const hex = process.env[name];
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

// --- Split-view thresholds ---
const SPLIT_MIN_WIDTH = envInt("DIFF_SPLIT_MIN_WIDTH", 150);
const SPLIT_MIN_CODE_WIDTH = envInt("DIFF_SPLIT_MIN_CODE_WIDTH", 60);
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;

// --- Terminal bounds ---
const MAX_TERM_WIDTH = 210;
const DEFAULT_TERM_WIDTH = 200;

// --- Rendering limits ---
const MAX_HL_CHARS = 80_000;
const CACHE_LIMIT = 192;

// --- Word diff ---
const WORD_DIFF_MIN_SIM = 0.15;

// --- Wrapping ---
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;
const DEFAULT_RENDER_WIDTH = 120;
const MIN_RENDER_WIDTH = 40;

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

let RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// Diff backgrounds — env overrides only; no hardcoded dark defaults.
// Theme derivation sets these on first render. Empty string = no bg (terminal default).
let BG_ADD = envBg("DIFF_BG_ADD", "");
let BG_DEL = envBg("DIFF_BG_DEL", "");
let BG_ADD_W = envBg("DIFF_BG_ADD_HL", "");
let BG_DEL_W = envBg("DIFF_BG_DEL_HL", "");
let BG_GUTTER_ADD = envBg("DIFF_BG_GUTTER_ADD", "");
let BG_GUTTER_DEL = envBg("DIFF_BG_GUTTER_DEL", "");
let BG_EMPTY = ""; // filler rows — set on theme derive

// Diff foregrounds — env overrides only
let FG_ADD = envFg("DIFF_FG_ADD", "");
let FG_DEL = envFg("DIFF_FG_DEL", "");
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";

const BORDER_BAR = "▌"; // left border for changed lines, matching the original pi-diff layout

let DIVIDER = `${FG_RULE}\u2502${RST}`;
const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([^m]*)m`, "g");
const ANSI_PARAM_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
const BG_DEFAULT = "\x1b[49m";
let BG_BASE = BG_DEFAULT;

// ---------------------------------------------------------------------------
// Theme-aware diff colors
// ---------------------------------------------------------------------------

/** Resolved ANSI colors for diff rendering. */
export interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}

let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
let _lastResolvedThemeKey = "";
let _autoDerivePending = true; // always attempt auto-derive on first render

// Track last used Shiki theme to clear highlight cache on switch
let _lastShikiTheme = THEME;

/** Parse 24-bit ANSI color code -> RGB. Works for both fg and bg escapes. */
function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

/** Convert "#RRGGBB" hex -> ANSI 24-bit background escape. */
function hexToBgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** Convert "#RRGGBB" hex -> ANSI 24-bit foreground escape. */
function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Compute relative luminance from RGB (0-255). Formula: WCAG 2.0. */
function luminance(r: number, g: number, b: number): number {
	const rs = r / 255;
	const gs = g / 255;
	const bs = b / 255;
	const R = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
	const G = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
	const B = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);
	return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** Detect if the pi theme has a light background (toolSuccessBg luminance > 0.5). */
function isLightBg(theme: any): boolean {
	try {
		const bgAnsi = theme.getBgAnsi("toolSuccessBg");
		const rgb = parseAnsiRgb(bgAnsi);
		if (!rgb) return false;
		return luminance(rgb.r, rgb.g, rgb.b) > 0.5;
	} catch {
		return false;
	}
}

/** Mix an accent color into a base color at the given intensity (0.0-1.0).
 *  Returns an ANSI 24-bit background escape. */
function mixBg(
	base: { r: number; g: number; b: number },
	accent: { r: number; g: number; b: number },
	intensity: number,
): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** Auto-derive all diff background colors from the pi theme.
 *
 *  Reads toolSuccessBg as the add/context base and toolErrorBg as the delete base,
 *  then mixes accent colors into each at theme-aware intensities.
 *  Light themes get higher intensity (more visible tints), dark themes get subtle tints. */
function autoDeriveBgFromTheme(theme: any): void {
	if (!theme?.getFgAnsi) return;
	try {
		const fgAdd = theme.getFgAnsi("toolDiffAdded");
		const fgDel = theme.getFgAnsi("toolDiffRemoved");
		const addRgb = parseAnsiRgb(fgAdd);
		const delRgb = parseAnsiRgb(fgDel);
		if (!addRgb || !delRgb) return;

		let addBase = { r: 0, g: 0, b: 0 };
		let delBase = addBase;
		const light = isLightBg(theme);

		if (theme.getBgAnsi) {
			try {
				const successBgAnsi = theme.getBgAnsi("toolSuccessBg");
				const successParsed = parseAnsiRgb(successBgAnsi);
				if (successParsed) {
					addBase = successParsed;
					delBase = successParsed;
					BG_BASE = successBgAnsi;
				}
			} catch {
				/* no toolSuccessBg — use black */
			}

			try {
				const errorParsed = parseAnsiRgb(theme.getBgAnsi("toolErrorBg"));
				if (errorParsed) delBase = errorParsed;
			} catch {
				/* no toolErrorBg — use toolSuccessBg/black */
			}
		}

		if (light) {
			// Light background: higher intensity so tints are visible
			BG_ADD = mixBg(addBase, addRgb, 0.22);
			BG_DEL = mixBg(delBase, delRgb, 0.25);
			BG_ADD_W = mixBg(addBase, addRgb, 0.38);
			BG_DEL_W = mixBg(delBase, delRgb, 0.40);
			BG_GUTTER_ADD = mixBg(addBase, addRgb, 0.14);
			BG_GUTTER_DEL = mixBg(delBase, delRgb, 0.16);
		} else {
			// Dark background: subtle intensity to let syntax fg shine
			BG_ADD = mixBg(addBase, addRgb, 0.08);
			BG_DEL = mixBg(delBase, delRgb, 0.10);
			BG_ADD_W = mixBg(addBase, addRgb, 0.20);
			BG_DEL_W = mixBg(delBase, delRgb, 0.22);
			BG_GUTTER_ADD = mixBg(addBase, addRgb, 0.05);
			BG_GUTTER_DEL = mixBg(delBase, delRgb, 0.06);
		}

		// Empty filler — match the success/context base
		BG_EMPTY = BG_BASE;

		// Update RST to re-apply base bg after every reset
		RST = `\x1b[0m${BG_BASE}`;

		// Rebuild derived constants
		DIVIDER = `${FG_RULE}\u2502${RST}`;

		// Auto-select Shiki syntax theme based on background luminance
		const newShiki = light ? "github-light" : "github-dark";
		if (newShiki !== THEME) {
			THEME = newShiki as BundledTheme;
			_clearHighlightCache();
		}
	} catch {
		// Fall back to defaults silently
	}
}

/** Load diff theme config from .pi/settings.json (project-level, then global). */
function loadDiffConfig(): DiffUserConfig {
	const paths = [`${process.cwd()}/.pi/settings.json`, `${process.env.HOME ?? ""}/.pi/settings.json`];
	for (const p of paths) {
		try {
			if (existsSync(p)) {
				const raw = JSON.parse(readFileSync(p, "utf-8"));
				if (raw.diffTheme || raw.diffColors) {
					return { diffTheme: raw.diffTheme, diffColors: raw.diffColors };
				}
			}
		} catch {
			// skip invalid files
		}
	}
	return {};
}

/** Apply diff palette from settings -> presets -> env overrides.
 *  Theme auto-derive always runs on first render regardless of settings.
 *  Explicit settings override specific colors AFTER theme derivation. */
export function applyDiffPalette(): void {
	const config = loadDiffConfig();
	const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme] : null;
	const ov = config.diffColors ?? {};

	// Helper: apply a hex bg color (env wins over settings, preset is fallback)
	const applyBg = (envName: string | null, key: string, presetVal: string | undefined, set: (v: string) => void) => {
		if (envName && process.env[envName]) return; // env override wins everything
		const hex = ov[key] ?? presetVal;
		if (hex) {
			const a = hexToBgAnsi(hex);
			if (a) set(a);
		}
	};
	// Helper: apply a hex fg color
	const applyFg = (envName: string | null, key: string, presetVal: string | undefined, set: (v: string) => void) => {
		if (envName && process.env[envName]) return;
		const hex = ov[key] ?? presetVal;
		if (hex) {
			const a = hexToFgAnsi(hex);
			if (a) set(a);
		}
	};

	// --- Apply backgrounds ---
	applyBg("DIFF_BG_ADD", "bgAdd", preset?.bgAdd, (v) => {
		BG_ADD = v;
	});
	applyBg("DIFF_BG_DEL", "bgDel", preset?.bgDel, (v) => {
		BG_DEL = v;
	});
	applyBg("DIFF_BG_ADD_HL", "bgAddHighlight", preset?.bgAddHighlight, (v) => {
		BG_ADD_W = v;
	});
	applyBg("DIFF_BG_DEL_HL", "bgDelHighlight", preset?.bgDelHighlight, (v) => {
		BG_DEL_W = v;
	});
	applyBg("DIFF_BG_GUTTER_ADD", "bgGutterAdd", preset?.bgGutterAdd, (v) => {
		BG_GUTTER_ADD = v;
	});
	applyBg("DIFF_BG_GUTTER_DEL", "bgGutterDel", preset?.bgGutterDel, (v) => {
		BG_GUTTER_DEL = v;
	});
	applyBg(null, "bgEmpty", preset?.bgEmpty, (v) => {
		BG_EMPTY = v;
	});

	// --- Apply foregrounds ---
	applyFg("DIFF_FG_ADD", "fgAdd", preset?.fgAdd, (v) => {
		FG_ADD = v;
	});
	applyFg("DIFF_FG_DEL", "fgDel", preset?.fgDel, (v) => {
		FG_DEL = v;
	});
	applyFg(null, "fgDim", preset?.fgDim, (v) => {
		FG_DIM = v;
	});
	applyFg(null, "fgLnum", preset?.fgLnum, (v) => {
		FG_LNUM = v;
	});
	applyFg(null, "fgRule", preset?.fgRule, (v) => {
		FG_RULE = v;
	});
	applyFg(null, "fgStripe", preset?.fgStripe, (v) => {
		FG_STRIPE = v;
	});
	applyFg(null, "fgSafeMuted", preset?.fgSafeMuted, (v) => {
		FG_SAFE_MUTED = v;
	});

	// --- Shiki syntax theme from settings ---
	const shiki = ov.shikiTheme ?? preset?.shikiTheme;
	if (shiki) THEME = shiki as BundledTheme;

	// --- Rebuild derived constants ---
	DIVIDER = `${FG_RULE}\u2502${RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };

	// Auto-derive always runs on first render regardless of explicit config
	_autoDerivePending = true;
}

/** Generate a cache key for the pi theme — used to detect theme changes. */
export function themeCacheKey(theme?: any): string {
	if (!theme?.fg) return "no-theme";
	const fgKeys = [
		"toolTitle",
		"accent",
		"muted",
		"success",
		"error",
		"toolDiffAdded",
		"toolDiffRemoved",
		"toolDiffContext",
	];
	const bgKeys = ["toolSuccessBg", "toolErrorBg"];
	const parts: string[] = [];
	for (const key of fgKeys) {
		try {
			parts.push(theme.fg(key, key));
		} catch {
			parts.push(key);
		}
	}
	for (const key of bgKeys) {
		try {
			parts.push(theme.bg ? theme.bg(key, key) : key);
		} catch {
			parts.push(key);
		}
	}
	return parts.join("|");
}

/** Resolve diff fg colors from theme, falling back to env/settings values.
 *  On first call (or after theme change), auto-derives ALL diff bg colors from the theme.
 *  Always reads toolSuccessBg for BG_BASE. */
export function resolveDiffColors(theme?: any): DiffColors {
	const currentThemeKey = themeCacheKey(theme);

	// On theme change, reset so auto-derive runs fresh
	if (_lastResolvedThemeKey && _lastResolvedThemeKey !== currentThemeKey) {
		BG_BASE = BG_DEFAULT;
		RST = "\x1b[0m";
		_autoDerivePending = true;
	}
	_lastResolvedThemeKey = currentThemeKey;

	// Always read toolSuccessBg for BG_BASE (even with explicit config)
	if (theme?.getBgAnsi && BG_BASE === BG_DEFAULT) {
		try {
			const bgAnsi = theme.getBgAnsi("toolSuccessBg");
			const parsed = parseAnsiRgb(bgAnsi);
			if (parsed) {
				BG_BASE = bgAnsi;
				RST = `\x1b[0m${BG_BASE}`;
			}
		} catch {
			/* ignore */
		}
	}

	// Auto-derive bg colors from theme on first render — ALWAYS runs
	if (_autoDerivePending && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme);
		_autoDerivePending = false;
	}

	if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;
	try {
		// Use theme fg if available, fall back to hardcoded if not
		const fgAdd = theme.getFgAnsi("toolDiffAdded") || (FG_ADD || `\x1b[38;2;100;180;120m`);
		const fgDel = theme.getFgAnsi("toolDiffRemoved") || (FG_DEL || `\x1b[38;2;200;100;100m`);
		const fgCtx = theme.getFgAnsi("toolDiffContext") || FG_DIM;
		return { fgAdd, fgDel, fgCtx };
	} catch {
		return DEFAULT_DIFF_COLORS;
	}
}

// ---------------------------------------------------------------------------
// Adaptive helpers
// ---------------------------------------------------------------------------

function adaptiveWrapRows(width: number): number {
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function tabs(s: string): string {
	return s.replace(/\t/g, "  ");
}

function fit(s: string, w: number): string {
	if (w <= 0) return "";
	const plain = strip(s);
	if (plain.length <= w) return s + " ".repeat(w - plain.length);
	const showW = w > 2 ? w - 1 : w;
	let vis = 0,
		i = 0;
	while (i < s.length && vis < showW) {
		if (s[i] === "\x1b") {
			const e = s.indexOf("m", i);
			if (e !== -1) {
				i = e + 1;
				continue;
			}
		}
		vis++;
		i++;
	}
	return w > 2 ? `${s.slice(0, i)}${RST}${FG_DIM}\u203A${RST}` : `${s.slice(0, i)}${RST}`;
}

/** Extract last active fg + bg ANSI codes from a string. */
function ansiState(s: string): string {
	let fg = "",
		bg = "";
	for (const match of s.matchAll(ANSI_CAPTURE_RE)) {
		const p = match[1] ?? "";
		const seq = match[0] ?? "";
		if (p === "0") {
			fg = "";
			bg = "";
		} else if (p === "39") {
			fg = "";
		} else if (p.startsWith("38;")) {
			fg = seq;
		} else if (p.startsWith("48;")) {
			bg = seq;
		}
	}
	return bg + fg;
}

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return false;
	const [, , r, g, b] = parts;
	const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return lum < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_PARAM_CAPTURE_RE, (seq, params: string) =>
		isLowContrastShikiFg(params) ? FG_SAFE_MUTED : seq,
	);
}

/** Wrap ANSI-encoded string into rows of `w` visible chars. Max `maxRows` rows; last row truncates with indicator. */
function wrapAnsi(s: string, w: number, maxRows: number, fillBg = ""): string[] {
	if (w <= 0) return [""];
	const plain = strip(s);
	if (plain.length <= w) {
		const pad = w - plain.length;
		return pad > 0 ? [s + fillBg + " ".repeat(pad) + (fillBg ? RST : "")] : [s];
	}

	const rows: string[] = [];
	let row = "",
		vis = 0,
		i = 0;
	let onLastRow = false;
	let effW = w;

	while (i < s.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effW = w > 2 ? w - 1 : w;
		}

		if (s[i] === "\x1b") {
			const end = s.indexOf("m", i);
			if (end !== -1) {
				row += s.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}

		if (vis >= effW) {
			if (onLastRow) {
				let hasMore = false;
				for (let j = i; j < s.length; j++) {
					if (s[j] === "\x1b") {
						const e2 = s.indexOf("m", j);
						if (e2 !== -1) {
							j = e2;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && w > 2) row += `${RST}${FG_DIM}\u203A${RST}`;
				else row += fillBg + " ".repeat(Math.max(0, w - vis)) + RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + RST);
			row = state + fillBg;
			vis = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effW = w > 2 ? w - 1 : w;
			}
		}

		row += s[i];
		vis++;
		i++;
	}

	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, w - vis)) + RST);
	}
	return rows;
}

function lnum(n: number | null, w: number, fg = FG_LNUM): string {
	if (n === null) return " ".repeat(w);
	const v = String(n);
	return `${fg}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

function rule(width: number): string {
	return `${BG_BASE}${FG_RULE}${"\u2500".repeat(width)}${RST}`;
}

function shouldUseSplit(diff: ParsedDiff, width: number, maxRows: number): boolean {
	if (!diff.lines.length) return false;
	if (width < SPLIT_MIN_WIDTH) return false;

	const nw = Math.max(
		2,
		String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	const half = Math.floor((width - 1) / 2);
	const gw = nw + 5;
	const cw = Math.max(12, half - gw);
	if (cw < SPLIT_MIN_CODE_WIDTH) return false;

	const vis = diff.lines.slice(0, maxRows);
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const l of vis) {
		if (l.type === "sep") continue;
		contentLines++;
		if (tabs(l.content).length > cw) wrapCandidates++;
	}
	if (contentLines === 0) return true;

	const wrapRatio = wrapCandidates / contentLines;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
};

/** Detect Shiki language from file path extension. */
export function lang(fp: string): BundledLanguage | undefined {
	return EXT_LANG[extname(fp).slice(1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Shiki ANSI cache + pre-warm
// ---------------------------------------------------------------------------

// Pre-warm the Shiki singleton (loads WASM grammars + theme)
codeToANSI("", "typescript", THEME).catch(() => {});

const _cache = new Map<string, string[]>();

function _clearHighlightCache(): void {
	_cache.clear();
}

function _touch(k: string, v: string[]): string[] {
	_cache.delete(k);
	_cache.set(k, v);
	while (_cache.size > CACHE_LIMIT) {
		const first = _cache.keys().next().value;
		if (first === undefined) break;
		_cache.delete(first);
	}
	return v;
}

export async function highlightCodeBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	return hlBlock(code, language);
}

/** Render a compact code preview with line numbers, but without diff markers or diff backgrounds. */
export async function renderCodeFrame(
	content: string,
	language: BundledLanguage | undefined,
	maxLines: number,
	width: number,
): Promise<string> {
	const lines = content.length > 0 ? content.split("\n") : [""];
	const visibleLines = lines.slice(0, maxLines);
	const highlighted = content.length <= MAX_HL_CHARS ? await hlBlock(visibleLines.join("\n"), language) : visibleLines;
	const lineNumberWidth = Math.max(2, String(visibleLines.length).length);
	const gutterWidth = lineNumberWidth + 4;
	const longestLine = Math.max(0, ...visibleLines.map((line) => tabs(line).length));
	const renderWidth = Math.min(Math.max(MIN_RENDER_WIDTH, width), Math.max(MIN_RENDER_WIDTH, longestLine + gutterWidth));
	const codeWidth = Math.max(20, renderWidth - gutterWidth);
	const output: string[] = [];

	for (let index = 0; index < visibleLines.length; index++) {
		const sourceLine = highlighted[index] ?? visibleLines[index] ?? "";
		const gutter = `${lnum(index + 1, lineNumberWidth)} ${FG_RULE}│${RST} `;
		const continuationGutter = `${" ".repeat(lineNumberWidth)} ${FG_RULE}│${RST} `;
		const rows = wrapAnsi(tabs(sourceLine), codeWidth, adaptiveWrapRows(renderWidth));
		output.push(`${gutter}${rows[0]}${RST}`);
		for (let row = 1; row < rows.length; row++) output.push(`${continuationGutter}${rows[row]}${RST}`);
	}

	if (lines.length > visibleLines.length) {
		output.push(`${FG_DIM}… ${lines.length - visibleLines.length} more lines${RST}`);
	}
	return output.join("\n");
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");

	const k = `${THEME}\0${language}\0${code}`;
	const hit = _cache.get(k);
	if (hit) return _touch(k, hit);

	try {
		const ansi = normalizeShikiContrast(await codeToANSI(code, language, THEME));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return _touch(k, out);
	} catch {
		return code.split("\n");
	}
}

// ---------------------------------------------------------------------------
// Word diff + bg injection
//
// Key insight: Shiki's codeToANSI only emits fg codes (\x1b[38;...m and
// \x1b[39m). It never sets backgrounds. So we can layer a diff bg underneath
// and it persists through all fg switches. For word-level emphasis we swap
// the bg to a brighter shade at changed character positions.
// ---------------------------------------------------------------------------

/**
 * Combined word diff analysis — single Diff.diffWords() call returns both
 * similarity score and character ranges for emphasis highlighting.
 */
function wordDiffAnalysis(
	a: string,
	b: string,
): {
	similarity: number;
	oldRanges: Array<[number, number]>;
	newRanges: Array<[number, number]>;
} {
	if (!a && !b) return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = Diff.diffWords(a, b);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oPos = 0,
		nPos = 0,
		same = 0;
	for (const p of parts) {
		if (p.removed) {
			oldRanges.push([oPos, oPos + p.value.length]);
			oPos += p.value.length;
		} else if (p.added) {
			newRanges.push([nPos, nPos + p.value.length]);
			nPos += p.value.length;
		} else {
			const len = p.value.length;
			same += len;
			oPos += len;
			nPos += len;
		}
	}
	const maxLen = Math.max(a.length, b.length);
	return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges };
}

/**
 * Inject diff background into Shiki ANSI output.
 * `baseBg` on unchanged spans, `hlBg` on changed character ranges.
 * Re-injects bg after any full reset (\x1b[0m).
 */
function injectBg(ansiLine: string, ranges: Array<[number, number]>, baseBg: string, hlBg: string): string {
	if (!ranges.length) return baseBg + ansiLine + RST;

	let out = baseBg;
	let vis = 0;
	let inHL = false;
	let ri = 0;
	let i = 0;

	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const m = ansiLine.indexOf("m", i);
			if (m !== -1) {
				const seq = ansiLine.slice(i, m + 1);
				out += seq;
				if (seq === "\x1b[0m") out += inHL ? hlBg : baseBg;
				i = m + 1;
				continue;
			}
		}
		while (ri < ranges.length && vis >= ranges[ri][1]) ri++;
		const want = ri < ranges.length && vis >= ranges[ri][0] && vis < ranges[ri][1];
		if (want !== inHL) {
			inHL = want;
			out += inHL ? hlBg : baseBg;
		}
		out += ansiLine[i];
		vis++;
		i++;
	}
	return out + RST;
}

/** Simple word diff (no syntax hl) — fallback when Shiki isn't available. */
function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText);
	let o = "",
		n = "";
	for (const p of parts) {
		if (p.removed) o += `${BG_DEL_W}${p.value}${RST}${BG_DEL}`;
		else if (p.added) n += `${BG_ADD_W}${p.value}${RST}${BG_ADD}`;
		else {
			o += p.value;
			n += p.value;
		}
	}
	return { old: o, new: n };
}

// ---------------------------------------------------------------------------
// Stacked (unified) view — clean single-column layout
// ---------------------------------------------------------------------------

export async function renderUnified(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	maxLines: number,
	colors: DiffColors,
	width: number,
): Promise<string> {
	if (!diff.lines.length) return "";

	const vis = diff.lines.slice(0, maxLines);
	const renderWidth = Math.max(MIN_RENDER_WIDTH, width);
	const nw = Math.max(
		2,
		String(Math.max(...vis.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	const gw = nw + 5;
	const cw = Math.max(20, renderWidth - gw);
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length <= maxLines;

	const oldSrc: string[] = [],
		newSrc: string[] = [];
	for (const l of vis) {
		if (l.type === "ctx" || l.type === "del") oldSrc.push(l.content);
		if (l.type === "ctx" || l.type === "add") newSrc.push(l.content);
	}
	const [oldHL, newHL] = canHL
		? await Promise.all([hlBlock(oldSrc.join("\n"), language), hlBlock(newSrc.join("\n"), language)])
		: [oldSrc, newSrc];

	let oI = 0,
		nI = 0,
		idx = 0;
	const out: string[] = [];
	out.push(rule(renderWidth));

	function emitRow(
		num: number | null,
		sign: string,
		gutterBg: string,
		signFg: string,
		body: string,
		bodyBg = "",
	): void {
		const borderFg = sign === "-" ? colors.fgDel : sign === "+" ? colors.fgAdd : "";
		const border = borderFg ? `${borderFg}${BORDER_BAR}${RST}` : `${BG_BASE} `;
		const numFg = borderFg || FG_LNUM;
		const gutter = `${border}${gutterBg}${lnum(num, nw, numFg)}${signFg}${sign}${RST} ${DIVIDER} `;
		const contGutter = `${border}${gutterBg}${" ".repeat(nw + 1)}${RST} ${DIVIDER} `;
		const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(renderWidth), bodyBg);
		out.push(`${gutter}${rows[0]}${RST}`);
		for (let r = 1; r < rows.length; r++) out.push(`${contGutter}${rows[r]}${RST}`);
	}

	while (idx < vis.length) {
		const l = vis[idx];

		if (l.type === "sep") {
			const gap = l.newNum;
			const label = gap && gap > 0 ? ` ${gap} unmodified lines ` : "\u00B7\u00B7\u00B7";
			const totalW = Math.min(renderWidth, 72);
			const pad = Math.max(0, totalW - label.length - 2);
			const half1 = Math.floor(pad / 2),
				half2 = pad - half1;
			out.push(`${BG_BASE}${FG_DIM}${"\u2500".repeat(half1)}${label}${"\u2500".repeat(half2)}${RST}`);
			idx++;
			continue;
		}

		if (l.type === "ctx") {
			const hl = oldHL[oI] ?? l.content;
			emitRow(l.newNum, " ", BG_BASE, colors.fgCtx, `${BG_BASE}${DIM}${hl}`, BG_BASE);
			oI++;
			nI++;
			idx++;
			continue;
		}

		const dels: Array<{ l: (typeof vis)[number]; hl: string }> = [];
		while (idx < vis.length && vis[idx].type === "del") {
			dels.push({ l: vis[idx], hl: oldHL[oI] ?? vis[idx].content });
			oI++;
			idx++;
		}
		const adds: Array<{ l: (typeof vis)[number]; hl: string }> = [];
		while (idx < vis.length && vis[idx].type === "add") {
			adds.push({ l: vis[idx], hl: newHL[nI] ?? vis[idx].content });
			nI++;
			idx++;
		}

		const isPaired = dels.length === 1 && adds.length === 1;
		const wd = isPaired ? wordDiffAnalysis(dels[0].l.content, adds[0].l.content) : null;

		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			const delBody = injectBg(dels[0].hl, wd.oldRanges, BG_DEL, BG_DEL_W);
			const addBody = injectBg(adds[0].hl, wd.newRanges, BG_ADD, BG_ADD_W);
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, `${colors.fgDel}${BOLD}`, delBody, BG_DEL);
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, `${colors.fgAdd}${BOLD}`, addBody, BG_ADD);
			continue;
		}
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(dels[0].l.content, adds[0].l.content);
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, `${colors.fgDel}${BOLD}`, `${BG_DEL}${pwd.old}`, BG_DEL);
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, `${colors.fgAdd}${BOLD}`, `${BG_ADD}${pwd.new}`, BG_ADD);
			continue;
		}

		for (const d of dels) {
			const body = canHL ? `${BG_DEL}${d.hl}` : `${BG_DEL}${d.l.content}`;
			emitRow(d.l.oldNum, "-", BG_GUTTER_DEL, `${colors.fgDel}${BOLD}`, body, BG_DEL);
		}
		for (const a of adds) {
			const body = canHL ? `${BG_ADD}${a.hl}` : `${BG_ADD}${a.l.content}`;
			emitRow(a.l.newNum, "+", BG_GUTTER_ADD, `${colors.fgAdd}${BOLD}`, body, BG_ADD);
		}
	}

	out.push(rule(renderWidth));
	if (diff.lines.length > vis.length) {
		out.push(`${BG_BASE}${FG_DIM}  \u2026 ${diff.lines.length - vis.length} more lines${RST}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Split view (auto-fallback to unified when narrow)
// ---------------------------------------------------------------------------

export async function renderSplit(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	maxLines: number,
	colors: DiffColors,
	width: number,
): Promise<string> {
	if (!shouldUseSplit(diff, width, maxLines)) return renderUnified(diff, language, maxLines, colors, width);
	if (!diff.lines.length) return "";

	type Row = { left: (typeof diff.lines)[number] | null; right: (typeof diff.lines)[number] | null };
	const rows: Row[] = [];
	let i = 0;
	while (i < diff.lines.length) {
		const l = diff.lines[i];
		if (l.type === "sep" || l.type === "ctx") {
			rows.push({ left: l, right: l });
			i++;
			continue;
		}
		const dels: (typeof diff.lines) = [],
			adds: (typeof diff.lines) = [];
		while (i < diff.lines.length && diff.lines[i].type === "del") {
			dels.push(diff.lines[i]);
			i++;
		}
		while (i < diff.lines.length && diff.lines[i].type === "add") {
			adds.push(diff.lines[i]);
			i++;
		}
		const n = Math.max(dels.length, adds.length);
		for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
	}

	const vis = rows.slice(0, maxLines);
	const renderWidth = Math.max(MIN_RENDER_WIDTH, width);
	const half = Math.floor((renderWidth - 1) / 2);
	const nw = Math.max(
		2,
		String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	const gw = nw + 5;
	const cw = Math.max(12, half - gw);
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length * 2 <= maxLines * 2;

	const leftSrc: string[] = [],
		rightSrc: string[] = [];
	for (const r of vis) {
		if (r.left && r.left.type !== "sep") leftSrc.push(r.left.content);
		if (r.right && r.right.type !== "sep") rightSrc.push(r.right.content);
	}
	const [leftHL, rightHL] = canHL
		? await Promise.all([hlBlock(leftSrc.join("\n"), language), hlBlock(rightSrc.join("\n"), language)])
		: [leftSrc, rightSrc];

	let lI = 0,
		rI = 0;

	type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] };
	const emptyBody = `${BG_EMPTY}${" ".repeat(cw)}${RST}`;

	function half_build(
		line: (typeof diff.lines)[number] | null,
		hl: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): HalfResult {
		if (!line) {
			const gw2 = nw + 2;
			const g = `${BG_BASE} ${" ".repeat(gw2)}${FG_RULE}\u2502${RST} `;
			return { gutter: g, contGutter: g, bodyRows: [emptyBody] };
		}
		if (line.type === "sep") {
			const label = line.newNum && line.newNum > 0 ? `\u00B7\u00B7\u00B7 ${line.newNum} lines \u00B7\u00B7\u00B7` : "\u00B7\u00B7\u00B7";
			const g = `${BG_BASE} ${FG_DIM}${fit("", nw + 2)}${RST}${FG_RULE}\u2502${RST} `;
			return { gutter: g, contGutter: g, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${RST}`] };
		}

		const isDel = line.type === "del",
			isAdd = line.type === "add";
		const gBg = isDel ? BG_GUTTER_DEL : isAdd ? BG_GUTTER_ADD : BG_BASE;
		const cBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE;
		const sFg = isDel ? colors.fgDel : isAdd ? colors.fgAdd : colors.fgCtx;
		const sign = isDel ? "-" : isAdd ? "+" : " ";
		const num = isDel ? line.oldNum : isAdd ? line.newNum : side === "left" ? line.oldNum : line.newNum;

		const borderFg = isDel ? colors.fgDel : isAdd ? colors.fgAdd : "";
		const border = borderFg ? `${borderFg}${BORDER_BAR}${RST}` : ` ${BG_BASE}`;
		const numFg = borderFg || FG_LNUM;

		let body: string;
		if (ranges && ranges.length > 0) {
			body = injectBg(hl, ranges, cBg, isDel ? BG_DEL_W : BG_ADD_W);
		} else if (isDel || isAdd) {
			body = `${cBg}${hl}`;
		} else {
			body = `${BG_BASE}${DIM}${hl}`;
		}

		const gutter = `${border}${gBg}${lnum(num, nw, numFg)}${sFg}${BOLD}${sign}${RST} ${FG_RULE}\u2502${RST} `;
		const contGutter = `${border}${gBg}${" ".repeat(nw + 1)}${RST} ${FG_RULE}\u2502${RST} `;
		const bodyRows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(renderWidth), cBg);
		return { gutter, contGutter, bodyRows };
	}

	const out: string[] = [];
	out.push(`${rule(half)}${FG_RULE}\u250A${RST}${rule(half)}`);

	for (const r of vis) {
		const leftLine = r.left,
			rightLine = r.right;
		const paired = leftLine && rightLine && leftLine.type === "del" && rightLine.type === "add";
		const wd = paired ? wordDiffAnalysis(leftLine.content, rightLine.content) : null;

		let lResult: HalfResult, rResult: HalfResult;

		if (paired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			const lhl = leftHL[lI++] ?? leftLine.content;
			const rhl = rightHL[rI++] ?? rightLine.content;
			lResult = half_build(leftLine, lhl, wd.oldRanges, "left");
			rResult = half_build(rightLine, rhl, wd.newRanges, "right");
		} else if (paired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(leftLine.content, rightLine.content);
			lI++;
			rI++;
			lResult = half_build(leftLine, pwd.old, null, "left");
			rResult = half_build(rightLine, pwd.new, null, "right");
		} else {
			const lhl = leftLine && leftLine.type !== "sep" ? (leftHL[lI++] ?? leftLine?.content ?? "") : "";
			const rhl = rightLine && rightLine.type !== "sep" ? (rightHL[rI++] ?? rightLine?.content ?? "") : "";
			lResult = half_build(leftLine, lhl, null, "left");
			rResult = half_build(rightLine, rhl, null, "right");
		}

		const maxRows = Math.max(lResult.bodyRows.length, rResult.bodyRows.length);
		for (let row = 0; row < maxRows; row++) {
			const lg = row === 0 ? lResult.gutter : lResult.contGutter;
			const rg = row === 0 ? rResult.gutter : rResult.contGutter;
			const lb = lResult.bodyRows[row] ?? emptyBody;
			const rb = rResult.bodyRows[row] ?? emptyBody;
			out.push(`${lg}${lb}${DIVIDER}${rg}${rb}`);
		}
	}

	out.push(`${rule(half)}${FG_RULE}\u250A${RST}${rule(half)}`);
	if (rows.length > vis.length) {
		out.push(`${BG_BASE}${FG_DIM}  \u2026 ${rows.length - vis.length} more lines${RST}`);
	}
	return out.join("\n");
}
